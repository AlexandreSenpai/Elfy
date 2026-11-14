import { SIGNALING_CONFIG, STREAM_CONFIG } from '../domain/config';
import {
  ConnectionFailureDto,
  DataChannelEnvelopeDto,
  DataChannelMessageType,
  DataChannelPayload,
  StreamFpsOption,
} from '../domain/dtos';
import { parseDataChannelMessage } from '../domain/validators';
import { IStreamEngine, StreamEngineCallbacks, WebRtcStatsSnapshot } from '../ports';
import { getRtcConfiguration } from '../utils/stun';

interface ElfyMediaTestWindow extends Window {
  __ELFY_TEST_STREAM__?: MediaStream;
  __ELFY_FORCE_SYNTHETIC_STREAM__?: boolean;
}

interface SyntheticStreamController {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  timerId: number;
  frameCount: number;
  fps: StreamFpsOption;
}

interface PeerEntry {
  peerIdSafe: string;
  pc: RTCPeerConnection;
  dataChannel: RTCDataChannel | null;
  pendingIce: RTCIceCandidateInit[];
  pendingLocalIce: RTCIceCandidateInit[];
  canEmitIce: boolean;
  signalingChain: Promise<void>;
  iceRestartCount: number;
  receivedRemoteIceCount: number;
  disconnectTimer: number | null;
  offerTimeoutTimer: number | null;
  createdAt: number;
  lastSeenAt: number;
  missedPingCount: number;
  sessionToken: string;
  makingOffer: boolean;
  ignoreOffer: boolean;
  initialHandshakeDone: boolean;
  pendingRenegotiation: boolean;
  remoteStream: MediaStream | null;
}

interface StatsAccumulator {
  outboundFps: number;
  inboundFps: number;
  droppedFrames: number;
  rttMs: number;
  rttSamples: number;
}

type DataChannelDispatchHandler = (
  entry: PeerEntry,
  envelope: DataChannelEnvelopeDto
) => Promise<void> | void;

const isPolitePeer = (localPeerIdSafe: string, remotePeerIdSafe: string): boolean => {
  return localPeerIdSafe.localeCompare(remotePeerIdSafe) > 0;
};

const drawSyntheticFrame = (ctrl: SyntheticStreamController): void => {
  ctrl.frameCount += 1;
  const { ctx, canvas, frameCount, fps } = ctrl;
  const grad = ctx.createLinearGradient(0, 0, canvas.width, canvas.height);
  grad.addColorStop(0, '#13111c');
  grad.addColorStop(1, '#261835');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const x = 120 + ((frameCount * 6) % (canvas.width - 240));
  const y = 360 + Math.sin(frameCount * 0.12) * 140;
  ctx.fillStyle = '#ff6b9d';
  ctx.beginPath();
  ctx.arc(x, y, 48, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 36px sans-serif';
  ctx.fillText(`ELFY STREAM · ${fps} FPS · FRAME ${frameCount}`, 64, 96);
};

const updateSenderMaxFramerate = async (
  sender: RTCRtpSender,
  fps: StreamFpsOption
): Promise<void> => {
  if (sender.track?.kind !== 'video') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.encodings[0].maxFramerate = fps;
    await sender.setParameters(params);
  } catch {
    // Some browser implementations restrict setParameters on synthetic tracks.
  }
};

const accumulateStatReport = (
  stat: Record<string, unknown>,
  acc: StatsAccumulator
): void => {
  if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
    const fps = Number(stat.framesPerSecond ?? 0);
    if (fps > acc.outboundFps) acc.outboundFps = fps;
    return;
  }

  if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
    const fps = Number(stat.framesPerSecond ?? 0);
    const dropped = Number(stat.framesDropped ?? 0);
    if (fps > acc.inboundFps) acc.inboundFps = fps;
    acc.droppedFrames += dropped;
    return;
  }

  if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
    const rttSec = Number(stat.currentRoundTripTime ?? 0);
    if (rttSec <= 0) return;
    acc.rttMs += rttSec * 1000;
    acc.rttSamples += 1;
  }
};

const collectPeerStats = async (
  pc: RTCPeerConnection,
  acc: StatsAccumulator
): Promise<void> => {
  if (pc.connectionState === 'closed') return;
  try {
    const report = await pc.getStats();
    report.forEach((entry) => {
      accumulateStatReport(entry as unknown as Record<string, unknown>, acc);
    });
  } catch {
    // Peer may close concurrently while stats are polled.
  }
};

/**
 * Bidirectional multi-peer WebRTC engine supporting dynamic screen capture,
 * ICE buffering before remoteDescription, and RTCDataChannel renegotiation.
 */
export class WebRtcStreamEngine implements IStreamEngine {
  private localPeerIdSafe = 'local_peer';
  private callbacks: StreamEngineCallbacks = {};
  private peers = new Map<string, PeerEntry>();
  private expectedTokens = new Map<string, string>();
  private localStream: MediaStream | null = null;
  private currentFps: StreamFpsOption = STREAM_CONFIG.DEFAULT_FPS;
  private syntheticCtrl: SyntheticStreamController | null = null;

  private readonly dcDispatch: Record<DataChannelMessageType, DataChannelDispatchHandler> = {
    renegotiate_offer: (entry, env) => this.handleRenegotiateOffer(entry, env),
    renegotiate_answer: (entry, env) => this.handleRenegotiateAnswer(entry, env),
    renegotiate_ice: (entry, env) => this.handleRenegotiateIce(entry, env),
    ping: (entry, env) => this.handlePingMessage(entry, env),
    pong: (entry, env) => {
      this.callbacks.onDataChannelMessage?.(entry.peerIdSafe, env);
    },
    peer_roster_sync: (entry, env) => {
      this.callbacks.onDataChannelMessage?.(entry.peerIdSafe, env);
    },
    stream_started: (entry, env) => {
      this.callbacks.onDataChannelMessage?.(entry.peerIdSafe, env);
    },
    stream_stopped: (entry, env) => {
      this.handleRemoteStreamStopped(entry, env);
    },
    peer_left: (entry, env) => {
      this.callbacks.onDataChannelMessage?.(entry.peerIdSafe, env);
    },
  };

  configure(localPeerIdSafe: string, callbacks: StreamEngineCallbacks): void {
    this.localPeerIdSafe = localPeerIdSafe || 'local_peer';
    this.callbacks = callbacks;
  }

  registerPeerSessionToken(remotePeerIdSafe: string, sessionToken: string): void {
    if (!remotePeerIdSafe || !sessionToken) return;
    const existing = this.peers.get(remotePeerIdSafe);
    if (existing && existing.sessionToken !== sessionToken) {
      this.closePeer(remotePeerIdSafe);
    }
    this.expectedTokens.set(remotePeerIdSafe, sessionToken);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getRemoteStream(peerIdSafe: string): MediaStream | null {
    return this.peers.get(peerIdSafe)?.remoteStream ?? null;
  }

  getCurrentFps(): StreamFpsOption {
    return this.currentFps;
  }

  getConnectedPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  private createSyntheticStream(fps: StreamFpsOption): MediaStream {
    this.stopSyntheticController();
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('Failed to create 2D canvas context for synthetic stream');
    }

    const ctrl: SyntheticStreamController = {
      canvas,
      ctx,
      frameCount: 0,
      fps,
      timerId: 0,
    };

    drawSyntheticFrame(ctrl);
    ctrl.timerId = window.setInterval(() => drawSyntheticFrame(ctrl), Math.round(1000 / fps));
    this.syntheticCtrl = ctrl;

    return canvas.captureStream(fps);
  }

  private stopSyntheticController(): void {
    if (!this.syntheticCtrl) return;
    window.clearInterval(this.syntheticCtrl.timerId);
    this.syntheticCtrl = null;
  }

  private async acquireCaptureStream(fps: StreamFpsOption): Promise<MediaStream> {
    const win = window as ElfyMediaTestWindow;
    if (win.__ELFY_TEST_STREAM__) {
      return win.__ELFY_TEST_STREAM__;
    }

    const canDisplayCapture = Boolean(navigator.mediaDevices?.getDisplayMedia);
    if (win.__ELFY_FORCE_SYNTHETIC_STREAM__ || !canDisplayCapture) {
      return this.createSyntheticStream(fps);
    }

    try {
      return await navigator.mediaDevices.getDisplayMedia({
        video: {
          frameRate: { ideal: fps, max: fps },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
        },
        audio: true,
      });
    } catch (err) {
      if (navigator.webdriver && win.__ELFY_FORCE_SYNTHETIC_STREAM__ !== false) {
        return this.createSyntheticStream(fps);
      }
      throw err;
    }
  }

  async startScreenCapture(fps?: StreamFpsOption): Promise<MediaStream> {
    const targetFps = fps ?? this.currentFps;
    this.currentFps = targetFps;

    const existingVideo = this.localStream?.getVideoTracks()[0];
    if (this.localStream && existingVideo && existingVideo.readyState === 'live') {
      await this.setStreamFps(targetFps);
      return this.localStream;
    }

    if (this.localStream) {
      await this.stopScreenCapture();
    }

    const stream = await this.acquireCaptureStream(targetFps);
    this.localStream = stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        void this.stopScreenCapture();
      };
    }

    await this.syncLocalTracksAcrossPeers();
    return stream;
  }

  async stopScreenCapture(): Promise<void> {
    const stream = this.localStream;
    this.localStream = null;
    this.stopSyntheticController();

    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    for (const entry of this.peers.values()) {
      this.removeLocalSenders(entry, stream);
    }
  }

  private removeLocalSenders(entry: PeerEntry, oldStream: MediaStream | null): void {
    if (!oldStream || entry.pc.connectionState === 'closed') return;
    const oldTrackIds = new Set(oldStream.getTracks().map((t) => t.id));
    for (const sender of entry.pc.getSenders()) {
      if (sender.track && oldTrackIds.has(sender.track.id)) {
        entry.pc.removeTrack(sender);
      }
    }
  }

  private async syncLocalTracksAcrossPeers(): Promise<void> {
    if (!this.localStream) return;
    for (const entry of this.peers.values()) {
      await this.attachLocalTracksToPeer(entry, this.localStream);
    }
  }

  private async attachLocalTracksToPeer(
    entry: PeerEntry,
    stream: MediaStream
  ): Promise<void> {
    if (entry.pc.connectionState === 'closed') return;
    const transceivers = entry.pc.getTransceivers();

    for (const track of stream.getTracks()) {
      const existingTransceiver = transceivers.find(
        (t) =>
          t.direction !== 'stopped' &&
          t.currentDirection !== 'stopped' &&
          (t.sender.track?.kind === track.kind ||
            (t.sender.track === null && t.receiver.track?.kind === track.kind))
      );

      if (existingTransceiver) {
        if (
          existingTransceiver.direction === 'recvonly' ||
          existingTransceiver.direction === 'inactive'
        ) {
          existingTransceiver.direction = 'sendrecv';
        }
        await existingTransceiver.sender.replaceTrack(track);
        await updateSenderMaxFramerate(existingTransceiver.sender, this.currentFps);
        continue;
      }

      const existingSender = entry.pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (existingSender) {
        await existingSender.replaceTrack(track);
        await updateSenderMaxFramerate(existingSender, this.currentFps);
        continue;
      }

      const added = entry.pc.addTrack(track, stream);
      await updateSenderMaxFramerate(added, this.currentFps);
    }
  }

  private async replaceVideoTrackOnStreamAndPeers(
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ): Promise<void> {
    if (!this.localStream) return;
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    oldTrack.stop();

    for (const entry of this.peers.values()) {
      await this.replacePeerVideoTrack(entry, newTrack);
    }
  }

  private async replacePeerVideoTrack(
    entry: PeerEntry,
    newTrack: MediaStreamTrack
  ): Promise<void> {
    const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return;
    await sender.replaceTrack(newTrack);
    await updateSenderMaxFramerate(sender, this.currentFps);
  }

  async setStreamFps(fps: StreamFpsOption): Promise<void> {
    this.currentFps = fps;

    if (this.syntheticCtrl) {
      const ctrl = this.syntheticCtrl;
      window.clearInterval(ctrl.timerId);
      ctrl.fps = fps;
      ctrl.timerId = window.setInterval(
        () => drawSyntheticFrame(ctrl),
        Math.round(1000 / fps)
      );
    }

    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      await this.applyFpsToVideoTrack(videoTrack, fps);
    }

    for (const entry of this.peers.values()) {
      for (const sender of entry.pc.getSenders()) {
        await updateSenderMaxFramerate(sender, fps);
      }
    }
  }

  private async applyFpsToVideoTrack(
    videoTrack: MediaStreamTrack,
    fps: StreamFpsOption
  ): Promise<void> {
    try {
      await videoTrack.applyConstraints({ frameRate: { ideal: fps, max: fps } });
    } catch {
      // Synthetic canvas tracks may ignore applyConstraints; handled below.
    }

    const reportedFps = videoTrack.getSettings().frameRate;
    if (!this.syntheticCtrl || reportedFps === fps) return;

    const refreshed = this.syntheticCtrl.canvas.captureStream(fps).getVideoTracks()[0];
    if (!refreshed) return;
    await this.replaceVideoTrackOnStreamAndPeers(videoTrack, refreshed);
  }

  private enqueuePeerTask(entry: PeerEntry, task: () => Promise<void>): Promise<void> {
    const run = entry.signalingChain
      .catch(() => {})
      .then(async () => {
        if (entry.pc.connectionState === 'closed' || this.peers.get(entry.peerIdSafe) !== entry) {
          return;
        }
        await task();
      });
    entry.signalingChain = run.catch(() => {});
    return run;
  }

  private clearDisconnectTimer(entry: PeerEntry): void {
    if (entry.disconnectTimer === null) return;
    window.clearTimeout(entry.disconnectTimer);
    entry.disconnectTimer = null;
  }

  private clearOfferTimeoutTimer(entry: PeerEntry): void {
    if (entry.offerTimeoutTimer === null) return;
    window.clearTimeout(entry.offerTimeoutTimer);
    entry.offerTimeoutTimer = null;
  }

  private scheduleOfferTimeout(entry: PeerEntry): void {
    this.clearOfferTimeoutTimer(entry);
    entry.offerTimeoutTimer = window.setTimeout(() => {
      entry.offerTimeoutTimer = null;
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      if (entry.pc.connectionState === 'closed' || entry.initialHandshakeDone) return;
      if (entry.pc.signalingState !== 'have-local-offer') return;

      if (entry.pc.localDescription) {
        void this.callbacks.onSignalOffer?.(
          entry.peerIdSafe,
          entry.pc.localDescription.toJSON(),
          entry.sessionToken
        );
      }

      entry.offerTimeoutTimer = window.setTimeout(() => {
        entry.offerTimeoutTimer = null;
        if (this.peers.get(entry.peerIdSafe) !== entry) return;
        if (entry.pc.connectionState === 'closed' || entry.initialHandshakeDone) return;
        if (entry.pc.signalingState !== 'have-local-offer') return;

        this.callbacks.onPeerConnectionError?.({
          stage: 'sdp_handshake',
          reason: 'Peer did not answer the WebRTC offer in time (SDP handshake timed out).',
          details: `peer=${entry.peerIdSafe}, signalingState=${entry.pc.signalingState}, iceGatheringState=${entry.pc.iceGatheringState}`,
          peerIdSafe: entry.peerIdSafe,
          timestamp: Date.now(),
        });
      }, 5500);
    }, 3500);
  }

  private buildConnectionFailure(entry: PeerEntry): ConnectionFailureDto {
    const details = `peer=${entry.peerIdSafe}, connectionState=${entry.pc.connectionState}, iceConnectionState=${entry.pc.iceConnectionState}, iceGatheringState=${entry.pc.iceGatheringState}, receivedRemoteIceCount=${entry.receivedRemoteIceCount}, iceRestarts=${entry.iceRestartCount}`;

    if (entry.initialHandshakeDone) {
      return {
        stage: 'peer_disconnected',
        reason: 'Lost active P2P stream connection with remote peer.',
        details,
        peerIdSafe: entry.peerIdSafe,
        timestamp: Date.now(),
      };
    }

    if (entry.receivedRemoteIceCount === 0) {
      return {
        stage: 'ice_negotiation',
        reason: 'ICE negotiation failed (0 network candidates received from remote peer).',
        details,
        peerIdSafe: entry.peerIdSafe,
        timestamp: Date.now(),
      };
    }

    return {
      stage: 'ice_negotiation',
      reason: 'WebRTC NAT/Firewall negotiation failed across available network routes.',
      details,
      peerIdSafe: entry.peerIdSafe,
      timestamp: Date.now(),
    };
  }

  private triggerIceRestart(entry: PeerEntry): void {
    if (entry.pc.connectionState === 'closed' || entry.iceRestartCount >= 2) return;
    entry.iceRestartCount += 1;
    if (typeof entry.pc.restartIce === 'function') {
      entry.pc.restartIce();
    }
    void this.renegotiatePeer(entry.peerIdSafe);
  }

  private touchPeerActivity(entry: PeerEntry): void {
    entry.lastSeenAt = Date.now();
    entry.missedPingCount = 0;
  }

  private detachAndClosePeerEntry(entry: PeerEntry): void {
    this.clearDisconnectTimer(entry);
    this.clearOfferTimeoutTimer(entry);
    entry.pc.onicecandidate = null;
    entry.pc.ontrack = null;
    entry.pc.ondatachannel = null;
    entry.pc.onsignalingstatechange = null;
    entry.pc.oniceconnectionstatechange = null;
    entry.pc.onconnectionstatechange = null;

    for (const sender of entry.pc.getSenders()) {
      try {
        entry.pc.removeTrack(sender);
      } catch {
        // Ignore errors removing senders on an already closing RTCPeerConnection.
      }
    }

    if (entry.dataChannel) {
      entry.dataChannel.onopen = null;
      entry.dataChannel.onmessage = null;
      entry.dataChannel.onclose = null;
      entry.dataChannel.onerror = null;
      try {
        entry.dataChannel.close();
      } catch {
        // Ignore errors closing an already closing/closed DataChannel.
      }
      entry.dataChannel = null;
    }

    try {
      entry.pc.close();
    } catch {
      // Ignore errors closing an already closed RTCPeerConnection.
    }
  }

  private isDataChannelTransportHealthy(entry: PeerEntry): boolean {
    if (!entry.initialHandshakeDone || entry.dataChannel?.readyState !== 'open') return false;
    const ice = entry.pc.iceConnectionState;
    return ice === 'connected' || ice === 'completed';
  }

  private getOrCreatePeerEntry(remotePeerIdSafe: string, sessionToken: string): PeerEntry {
    const existing = this.peers.get(remotePeerIdSafe);
    const isReusable =
      existing &&
      existing.sessionToken === sessionToken &&
      this.isPeerHealthy(remotePeerIdSafe);

    if (isReusable) {
      return existing;
    }

    if (existing) {
      this.peers.delete(remotePeerIdSafe);
      this.detachAndClosePeerEntry(existing);
    }

    const now = Date.now();
    const pc = new RTCPeerConnection(getRtcConfiguration());
    const entry: PeerEntry = {
      peerIdSafe: remotePeerIdSafe,
      pc,
      dataChannel: null,
      pendingIce: [],
      pendingLocalIce: [],
      canEmitIce: true,
      signalingChain: Promise.resolve(),
      iceRestartCount: 0,
      receivedRemoteIceCount: 0,
      disconnectTimer: null,
      offerTimeoutTimer: null,
      createdAt: now,
      lastSeenAt: now,
      missedPingCount: 0,
      sessionToken,
      makingOffer: false,
      ignoreOffer: false,
      initialHandshakeDone: false,
      pendingRenegotiation: false,
      remoteStream: null,
    };

    this.bindPeerEvents(entry);
    this.peers.set(remotePeerIdSafe, entry);
    return entry;
  }

  private bindPeerEvents(entry: PeerEntry): void {
    entry.pc.onicecandidate = (event) => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      if (!event.candidate) return;
      this.emitIceCandidate(entry, event.candidate.toJSON());
    };

    entry.pc.ontrack = (event) => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      this.handleRemoteTrack(entry, event);
    };

    entry.pc.ondatachannel = (event) => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      if (event.channel.label !== SIGNALING_CONFIG.DATA_CHANNEL_LABEL) return;
      this.attachDataChannel(entry, event.channel);
    };

    entry.pc.onsignalingstatechange = () => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      if (entry.pc.signalingState === 'stable' && entry.pendingRenegotiation) {
        entry.pendingRenegotiation = false;
        void this.renegotiatePeer(entry.peerIdSafe);
      }
    };

    entry.pc.oniceconnectionstatechange = () => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      const iceState = entry.pc.iceConnectionState;
      if (iceState === 'connected' || iceState === 'completed') {
        this.clearDisconnectTimer(entry);
        entry.iceRestartCount = 0;
        return;
      }
      if (iceState === 'disconnected' && entry.pc.connectionState !== 'closed') {
        if (entry.disconnectTimer !== null) return;
        entry.disconnectTimer = window.setTimeout(() => {
          entry.disconnectTimer = null;
          if (this.peers.get(entry.peerIdSafe) !== entry) return;
          if (entry.pc.iceConnectionState !== 'disconnected') return;
          this.triggerIceRestart(entry);
        }, 3500);
        return;
      }
      if (iceState !== 'failed') return;
      this.clearDisconnectTimer(entry);
      if (entry.iceRestartCount >= 2) {
        if (entry.pc.connectionState === 'failed') {
          this.handleConnectionStateChange(entry);
        }
        return;
      }
      this.triggerIceRestart(entry);
    };

    entry.pc.onconnectionstatechange = () => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      this.handleConnectionStateChange(entry);
    };
  }

  private dispatchLocalIceCandidate(entry: PeerEntry, candidate: RTCIceCandidateInit): void {
    if (this.isDataChannelTransportHealthy(entry)) {
      this.sendDataChannelMessage(
        entry.peerIdSafe,
        { type: 'renegotiate_ice', fromPeerIdSafe: this.localPeerIdSafe, candidate },
        entry.sessionToken
      );
      return;
    }

    void this.callbacks.onSignalIce?.(entry.peerIdSafe, candidate, entry.sessionToken);
  }

  private emitIceCandidate(entry: PeerEntry, candidate: RTCIceCandidateInit): void {
    if (!entry.canEmitIce) {
      entry.pendingLocalIce.push(candidate);
      return;
    }
    this.dispatchLocalIceCandidate(entry, candidate);
  }

  private flushPendingLocalIce(entry: PeerEntry): void {
    if (!entry.canEmitIce) return;
    const buffered = entry.pendingLocalIce.splice(0, entry.pendingLocalIce.length);
    for (const candidate of buffered) {
      this.dispatchLocalIceCandidate(entry, candidate);
    }
  }

  private buildFreshRemoteStream(entry: PeerEntry, incomingTrack?: MediaStreamTrack): MediaStream | null {
    const tracks: MediaStreamTrack[] = [];
    const existingTracks = entry.remoteStream?.getTracks() ?? [];

    for (const track of existingTracks) {
      if (track.readyState === 'ended') continue;
      if (incomingTrack && (track.id === incomingTrack.id || track.kind === incomingTrack.kind)) {
        continue;
      }
      tracks.push(track);
    }

    if (incomingTrack && incomingTrack.readyState !== 'ended') {
      tracks.push(incomingTrack);
    }

    if (tracks.length === 0) return null;
    return new MediaStream(tracks);
  }

  private handleRemoteTrack(entry: PeerEntry, event: RTCTrackEvent): void {
    this.touchPeerActivity(entry);
    const stream = this.buildFreshRemoteStream(entry, event.track);
    if (!stream) return;

    entry.remoteStream = stream;
    this.callbacks.onRemoteStream?.(entry.peerIdSafe, stream);

    event.track.onunmute = () => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      if (entry.pc.connectionState === 'closed' || event.track.readyState === 'ended') return;
      const unmutedStream = this.buildFreshRemoteStream(entry, event.track);
      if (!unmutedStream) return;
      entry.remoteStream = unmutedStream;
      this.callbacks.onRemoteStream?.(entry.peerIdSafe, unmutedStream);
    };
  }

  private handleConnectionStateChange(entry: PeerEntry): void {
    const state = entry.pc.connectionState;
    this.callbacks.onPeerConnectionStateChange?.(entry.peerIdSafe, state);

    const shouldEvict = state === 'closed' || (state === 'failed' && entry.iceRestartCount >= 2);
    if (!shouldEvict) return;

    const failure = state === 'failed' ? this.buildConnectionFailure(entry) : null;
    entry.remoteStream = null;
    if (this.peers.get(entry.peerIdSafe) === entry) {
      this.peers.delete(entry.peerIdSafe);
      this.detachAndClosePeerEntry(entry);
    }
    this.callbacks.onRemoteStreamRemoved?.(entry.peerIdSafe);
    if (failure) {
      this.callbacks.onPeerConnectionError?.(failure);
    }
  }

  private attachDataChannel(entry: PeerEntry, channel: RTCDataChannel): void {
    entry.dataChannel = channel;

    channel.onopen = () => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      entry.initialHandshakeDone = true;
      this.touchPeerActivity(entry);
      this.clearOfferTimeoutTimer(entry);
      this.callbacks.onDataChannelOpen?.(entry.peerIdSafe);
    };

    channel.onmessage = (event: MessageEvent) => {
      if (this.peers.get(entry.peerIdSafe) !== entry) return;
      void this.handleRawDataChannelEvent(entry, event.data);
    };
  }

  private async handleRawDataChannelEvent(
    entry: PeerEntry,
    rawData: unknown
  ): Promise<void> {
    const envelope = parseDataChannelMessage(rawData);
    if (!envelope) return;
    if (envelope.sessionToken !== entry.sessionToken) return;
    this.touchPeerActivity(entry);

    const handler = this.dcDispatch[envelope.payload.type];
    if (!handler) return;
    await handler(entry, envelope);
  }

  private handleRemoteStreamStopped(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): void {
    entry.remoteStream = null;
    this.callbacks.onRemoteStreamRemoved?.(entry.peerIdSafe);
    this.callbacks.onDataChannelMessage?.(entry.peerIdSafe, envelope);
  }

  private handlePingMessage(entry: PeerEntry, envelope: DataChannelEnvelopeDto): void {
    if (envelope.payload.type !== 'ping') return;
    this.sendDataChannelMessage(
      entry.peerIdSafe,
      { type: 'pong', echoSentAt: envelope.payload.sentAt, respondedAt: Date.now() },
      entry.sessionToken
    );
    this.callbacks.onDataChannelMessage?.(entry.peerIdSafe, envelope);
  }

  private async flushPendingIce(entry: PeerEntry): Promise<void> {
    if (!entry.pc.remoteDescription) return;
    const buffered = entry.pendingIce.splice(0, entry.pendingIce.length);

    for (const candidate of buffered) {
      await this.addIceSafely(entry.pc, candidate);
    }
  }

  private async addIceSafely(
    pc: RTCPeerConnection,
    candidate: RTCIceCandidateInit
  ): Promise<void> {
    if (pc.connectionState === 'closed') return;
    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[WebRTC] Ignored ICE candidate error:', err);
    }
  }

  async initiatePeerConnection(
    remotePeerIdSafe: string,
    sessionToken: string
  ): Promise<void> {
    if (!remotePeerIdSafe || !sessionToken) return;
    const prev = this.peers.get(remotePeerIdSafe);
    if (prev) {
      this.peers.delete(remotePeerIdSafe);
      this.detachAndClosePeerEntry(prev);
    }
    this.expectedTokens.set(remotePeerIdSafe, sessionToken);
    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);

    return this.enqueuePeerTask(entry, async () => {
      if (!entry.dataChannel) {
        const dc = entry.pc.createDataChannel(SIGNALING_CONFIG.DATA_CHANNEL_LABEL, {
          ordered: true,
        });
        this.attachDataChannel(entry, dc);
      }

      if (this.localStream) {
        await this.attachLocalTracksToPeer(entry, this.localStream);
      }

      entry.makingOffer = true;
      entry.canEmitIce = false;
      try {
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        if (entry.pc.localDescription) {
          await this.callbacks.onSignalOffer?.(
            remotePeerIdSafe,
            entry.pc.localDescription.toJSON(),
            sessionToken
          );
        }
        entry.canEmitIce = true;
        this.flushPendingLocalIce(entry);
        this.scheduleOfferTimeout(entry);
      } finally {
        entry.makingOffer = false;
        entry.canEmitIce = true;
        if (entry.pc.localDescription) {
          this.flushPendingLocalIce(entry);
        }
      }
    });
  }

  async handleIncomingOffer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    const expected = this.expectedTokens.get(remotePeerIdSafe);
    if (!expected || expected !== sessionToken) return;

    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);
    if (entry.sessionToken !== sessionToken) return;

    return this.enqueuePeerTask(entry, async () => {
      const collision = entry.makingOffer || entry.pc.signalingState !== 'stable';
      const polite = isPolitePeer(this.localPeerIdSafe, remotePeerIdSafe);
      if (collision && !polite) return;

      if (collision && polite) {
        await entry.pc.setLocalDescription({ type: 'rollback' });
      }

      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushPendingIce(entry);

      if (this.localStream) {
        await this.attachLocalTracksToPeer(entry, this.localStream);
      }

      entry.canEmitIce = false;
      try {
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        if (entry.pc.localDescription) {
          await this.callbacks.onSignalAnswer?.(
            remotePeerIdSafe,
            entry.pc.localDescription.toJSON(),
            sessionToken
          );
        }
        entry.canEmitIce = true;
        this.flushPendingLocalIce(entry);
        this.scheduleOfferTimeout(entry);
      } finally {
        entry.canEmitIce = true;
        if (entry.pc.localDescription) {
          this.flushPendingLocalIce(entry);
        }
      }

      this.ensureLocalSendersNegotiated(entry);
    });
  }

  private ensureLocalSendersNegotiated(entry: PeerEntry): void {
    if (!this.localStream) return;
    const hasUnnegotiatedSender = entry.pc
      .getTransceivers()
      .some(
        (t) =>
          t.direction !== 'stopped' &&
          t.currentDirection !== 'stopped' &&
          t.sender.track !== null &&
          t.currentDirection !== 'sendrecv' &&
          t.currentDirection !== 'sendonly'
      );
    if (!hasUnnegotiatedSender) return;
    entry.pendingRenegotiation = true;
    void this.renegotiatePeer(entry.peerIdSafe);
  }

  async handleIncomingAnswer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== sessionToken) return;

    return this.enqueuePeerTask(entry, async () => {
      if (entry.pc.signalingState !== 'have-local-offer') return;
      this.touchPeerActivity(entry);
      this.clearOfferTimeoutTimer(entry);
      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
      await this.flushPendingIce(entry);
    });
  }

  async handleIncomingIce(
    remotePeerIdSafe: string,
    candidate: RTCIceCandidateInit,
    sessionToken: string
  ): Promise<void> {
    const expected = this.expectedTokens.get(remotePeerIdSafe);
    if (!expected || expected !== sessionToken) return;

    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);
    if (entry.sessionToken !== sessionToken) return;

    return this.enqueuePeerTask(entry, async () => {
      this.touchPeerActivity(entry);
      entry.receivedRemoteIceCount += 1;
      if (!entry.pc.remoteDescription) {
        entry.pendingIce.push(candidate);
        return;
      }

      await this.addIceSafely(entry.pc, candidate);
    });
  }

  sendDataChannelMessage<T extends DataChannelPayload>(
    remotePeerIdSafe: string,
    payload: T,
    sessionToken: string
  ): boolean {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== sessionToken) return false;
    if (!entry.dataChannel || entry.dataChannel.readyState !== 'open') return false;

    const envelope: DataChannelEnvelopeDto<T> = {
      version: 1,
      sessionToken,
      senderPeerIdSafe: this.localPeerIdSafe,
      sentAt: Date.now(),
      payload,
    };

    entry.dataChannel.send(JSON.stringify(envelope));
    return true;
  }

  broadcastDataChannelMessage<T extends DataChannelPayload>(
    payload: T,
    sessionToken: string
  ): void {
    for (const entry of this.peers.values()) {
      const token = entry.sessionToken || sessionToken;
      this.sendDataChannelMessage(entry.peerIdSafe, payload, token);
    }
  }

  async handleDataChannelRenegotiation(
    remotePeerIdSafe: string,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== envelope.sessionToken) return;

    const handler = this.dcDispatch[envelope.payload.type];
    if (!handler) return;
    await handler(entry, envelope);
  }

  private async handleRenegotiateOffer(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    if (envelope.payload.type !== 'renegotiate_offer') return;
    const sdpInit = envelope.payload.sdp;

    return this.enqueuePeerTask(entry, async () => {
      const collision = entry.makingOffer || entry.pc.signalingState !== 'stable';
      const polite = isPolitePeer(this.localPeerIdSafe, entry.peerIdSafe);
      entry.ignoreOffer = !polite && collision;
      if (entry.ignoreOffer) return;

      if (collision && polite) {
        await entry.pc.setLocalDescription({ type: 'rollback' });
      }

      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdpInit));
      await this.flushPendingIce(entry);

      if (this.localStream) {
        await this.attachLocalTracksToPeer(entry, this.localStream);
      }

      entry.canEmitIce = false;
      try {
        const answer = await entry.pc.createAnswer();
        await entry.pc.setLocalDescription(answer);
        if (entry.pc.localDescription) {
          const sdp = entry.pc.localDescription.toJSON();
          const sentOverDc =
            this.isDataChannelTransportHealthy(entry) &&
            this.sendDataChannelMessage(
              entry.peerIdSafe,
              {
                type: 'renegotiate_answer',
                fromPeerIdSafe: this.localPeerIdSafe,
                sdp,
              },
              entry.sessionToken
            );

          if (!sentOverDc) {
            await this.callbacks.onSignalAnswer?.(entry.peerIdSafe, sdp, entry.sessionToken);
          }
        }
        entry.canEmitIce = true;
        this.flushPendingLocalIce(entry);
        this.scheduleOfferTimeout(entry);
      } finally {
        entry.canEmitIce = true;
        if (entry.pc.localDescription) {
          this.flushPendingLocalIce(entry);
        }
      }

      this.ensureLocalSendersNegotiated(entry);
    });
  }

  private async handleRenegotiateAnswer(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    if (envelope.payload.type !== 'renegotiate_answer') return;
    const sdpInit = envelope.payload.sdp;

    return this.enqueuePeerTask(entry, async () => {
      if (entry.pc.signalingState !== 'have-local-offer') return;

      await entry.pc.setRemoteDescription(new RTCSessionDescription(sdpInit));
      await this.flushPendingIce(entry);
    });
  }

  private async handleRenegotiateIce(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    if (envelope.payload.type !== 'renegotiate_ice') return;
    const candidate = envelope.payload.candidate;

    return this.enqueuePeerTask(entry, async () => {
      this.touchPeerActivity(entry);
      entry.receivedRemoteIceCount += 1;
      if (!entry.pc.remoteDescription) {
        entry.pendingIce.push(candidate);
        return;
      }

      await this.addIceSafely(entry.pc, candidate);
    });
  }

  async renegotiatePeer(remotePeerIdSafe: string): Promise<void> {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.pc.connectionState === 'closed') return;

    return this.enqueuePeerTask(entry, async () => {
      if (entry.pc.connectionState === 'closed') return;
      if (entry.makingOffer || entry.pc.signalingState !== 'stable') {
        entry.pendingRenegotiation = true;
        return;
      }

      entry.pendingRenegotiation = false;
      entry.makingOffer = true;
      entry.canEmitIce = false;
      try {
        const offer = await entry.pc.createOffer();
        await entry.pc.setLocalDescription(offer);
        if (entry.pc.localDescription) {
          const sdp = entry.pc.localDescription.toJSON();
          const sentOverDc =
            this.isDataChannelTransportHealthy(entry) &&
            this.sendDataChannelMessage(
              entry.peerIdSafe,
              { type: 'renegotiate_offer', fromPeerIdSafe: this.localPeerIdSafe, sdp },
              entry.sessionToken
            );

          if (!sentOverDc) {
            await this.callbacks.onSignalOffer?.(entry.peerIdSafe, sdp, entry.sessionToken);
          }
        }
        entry.canEmitIce = true;
        this.flushPendingLocalIce(entry);
        this.scheduleOfferTimeout(entry);
      } finally {
        entry.makingOffer = false;
        entry.canEmitIce = true;
        if (entry.pc.localDescription) {
          this.flushPendingLocalIce(entry);
        }
      }
    });
  }

  async renegotiateAllPeers(): Promise<void> {
    for (const peerId of Array.from(this.peers.keys())) {
      await this.renegotiatePeer(peerId);
    }
  }

  hasPeer(peerIdSafe: string): boolean {
    return this.peers.has(peerIdSafe);
  }

  isPeerHealthy(peerIdSafe: string): boolean {
    const entry = this.peers.get(peerIdSafe);
    if (!entry) return false;
    if (entry.pc.connectionState === 'closed' || entry.pc.connectionState === 'failed') {
      return false;
    }
    if (entry.pc.iceConnectionState === 'closed' || entry.pc.iceConnectionState === 'failed') {
      return false;
    }
    if (entry.initialHandshakeDone && entry.dataChannel?.readyState !== 'open') {
      return false;
    }
    return true;
  }

  pingAndCleanupPeers(): string[] {
    const now = Date.now();
    const evicted: string[] = [];

    for (const [peerIdSafe, entry] of Array.from(this.peers.entries())) {
      if (!this.isPeerHealthy(peerIdSafe)) {
        this.closePeer(peerIdSafe);
        evicted.push(peerIdSafe);
        continue;
      }

      if (!entry.initialHandshakeDone && now - entry.createdAt > 12000) {
        this.closePeer(peerIdSafe);
        evicted.push(peerIdSafe);
        continue;
      }

      if (!entry.initialHandshakeDone || entry.dataChannel?.readyState !== 'open') {
        continue;
      }

      if (now - entry.lastSeenAt > 4500) {
        entry.missedPingCount += 1;
        if (entry.missedPingCount >= 3) {
          this.closePeer(peerIdSafe);
          evicted.push(peerIdSafe);
          continue;
        }
      }

      this.sendDataChannelMessage(peerIdSafe, { type: 'ping', sentAt: now }, entry.sessionToken);
    }

    return evicted;
  }

  closePeer(remotePeerIdSafe: string): void {
    this.expectedTokens.delete(remotePeerIdSafe);
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry) return;

    this.peers.delete(remotePeerIdSafe);
    this.detachAndClosePeerEntry(entry);
    this.callbacks.onRemoteStreamRemoved?.(remotePeerIdSafe);
  }

  closeAllPeers(): void {
    for (const peerId of Array.from(this.peers.keys())) {
      this.closePeer(peerId);
    }
    this.expectedTokens.clear();
  }

  async getStatsSnapshot(): Promise<WebRtcStatsSnapshot> {
    const acc: StatsAccumulator = {
      outboundFps: 0,
      inboundFps: 0,
      droppedFrames: 0,
      rttMs: 0,
      rttSamples: 0,
    };

    for (const entry of this.peers.values()) {
      await collectPeerStats(entry.pc, acc);
    }

    const rttMs = acc.rttSamples > 0 ? acc.rttMs / acc.rttSamples : 0;
    return {
      outboundFps: acc.outboundFps,
      inboundFps: acc.inboundFps,
      droppedFrames: acc.droppedFrames,
      rttMs,
    };
  }
}

export const webrtcStreamEngine: IStreamEngine = new WebRtcStreamEngine();
