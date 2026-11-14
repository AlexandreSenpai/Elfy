import { SIGNALING_CONFIG, STREAM_CONFIG } from '../domain/config';
import {
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
      if (navigator.webdriver) {
        return this.createSyntheticStream(fps);
      }
      throw err;
    }
  }

  async startScreenCapture(fps?: StreamFpsOption): Promise<MediaStream> {
    const targetFps = fps ?? this.currentFps;
    this.currentFps = targetFps;

    if (this.localStream) {
      await this.setStreamFps(targetFps);
      return this.localStream;
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
    const senders = entry.pc.getSenders();

    for (const track of stream.getTracks()) {
      const existingSender = senders.find((s) => s.track?.kind === track.kind);
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

  private getOrCreatePeerEntry(remotePeerIdSafe: string, sessionToken: string): PeerEntry {
    const existing = this.peers.get(remotePeerIdSafe);
    if (existing && existing.pc.connectionState !== 'closed') {
      return existing;
    }

    const pc = new RTCPeerConnection(getRtcConfiguration());
    const entry: PeerEntry = {
      peerIdSafe: remotePeerIdSafe,
      pc,
      dataChannel: null,
      pendingIce: [],
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
      if (!event.candidate) return;
      this.emitIceCandidate(entry, event.candidate.toJSON());
    };

    entry.pc.ontrack = (event) => {
      this.handleRemoteTrack(entry, event);
    };

    entry.pc.ondatachannel = (event) => {
      if (event.channel.label !== SIGNALING_CONFIG.DATA_CHANNEL_LABEL) return;
      this.attachDataChannel(entry, event.channel);
    };

    entry.pc.onsignalingstatechange = () => {
      if (entry.pc.signalingState === 'stable' && entry.pendingRenegotiation) {
        entry.pendingRenegotiation = false;
        void this.renegotiatePeer(entry.peerIdSafe);
      }
    };

    entry.pc.onconnectionstatechange = () => {
      this.handleConnectionStateChange(entry);
    };
  }

  private emitIceCandidate(entry: PeerEntry, candidate: RTCIceCandidateInit): void {
    const dcOpen = entry.initialHandshakeDone && entry.dataChannel?.readyState === 'open';
    if (dcOpen) {
      this.sendDataChannelMessage(
        entry.peerIdSafe,
        { type: 'renegotiate_ice', fromPeerIdSafe: this.localPeerIdSafe, candidate },
        entry.sessionToken
      );
      return;
    }

    void this.callbacks.onSignalIce?.(entry.peerIdSafe, candidate, entry.sessionToken);
  }

  private handleRemoteTrack(entry: PeerEntry, event: RTCTrackEvent): void {
    const stream = event.streams[0] ?? entry.remoteStream ?? new MediaStream();
    const hasTrack = stream.getTracks().some((t) => t.id === event.track.id);
    if (!hasTrack) {
      stream.addTrack(event.track);
    }

    entry.remoteStream = stream;
    this.callbacks.onRemoteStream?.(entry.peerIdSafe, stream);
  }

  private handleConnectionStateChange(entry: PeerEntry): void {
    const state = entry.pc.connectionState;
    this.callbacks.onPeerConnectionStateChange?.(entry.peerIdSafe, state);

    if (state === 'failed' || state === 'closed') {
      entry.remoteStream = null;
      this.callbacks.onRemoteStreamRemoved?.(entry.peerIdSafe);
    }
  }

  private attachDataChannel(entry: PeerEntry, channel: RTCDataChannel): void {
    entry.dataChannel = channel;

    channel.onopen = () => {
      entry.initialHandshakeDone = true;
      this.callbacks.onDataChannelOpen?.(entry.peerIdSafe);
    };

    channel.onmessage = (event: MessageEvent) => {
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
    this.expectedTokens.set(remotePeerIdSafe, sessionToken);
    const entry = this.getOrCreatePeerEntry(remotePeerIdSafe, sessionToken);

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
    } finally {
      entry.makingOffer = false;
    }
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

    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    if (!entry.pc.localDescription) return;

    await this.callbacks.onSignalAnswer?.(
      remotePeerIdSafe,
      entry.pc.localDescription.toJSON(),
      sessionToken
    );
  }

  async handleIncomingAnswer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== sessionToken) return;
    if (entry.pc.signalingState !== 'have-local-offer') return;

    await entry.pc.setRemoteDescription(new RTCSessionDescription(sdp));
    await this.flushPendingIce(entry);
  }

  async handleIncomingIce(
    remotePeerIdSafe: string,
    candidate: RTCIceCandidateInit,
    sessionToken: string
  ): Promise<void> {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.sessionToken !== sessionToken) return;

    if (!entry.pc.remoteDescription) {
      entry.pendingIce.push(candidate);
      return;
    }

    await this.addIceSafely(entry.pc, candidate);
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

    const collision = entry.makingOffer || entry.pc.signalingState !== 'stable';
    const polite = isPolitePeer(this.localPeerIdSafe, entry.peerIdSafe);
    entry.ignoreOffer = !polite && collision;
    if (entry.ignoreOffer) return;

    if (collision && polite) {
      await entry.pc.setLocalDescription({ type: 'rollback' });
    }

    await entry.pc.setRemoteDescription(new RTCSessionDescription(envelope.payload.sdp));
    await this.flushPendingIce(entry);

    const answer = await entry.pc.createAnswer();
    await entry.pc.setLocalDescription(answer);
    if (!entry.pc.localDescription) return;

    this.sendDataChannelMessage(
      entry.peerIdSafe,
      {
        type: 'renegotiate_answer',
        fromPeerIdSafe: this.localPeerIdSafe,
        sdp: entry.pc.localDescription.toJSON(),
      },
      entry.sessionToken
    );
  }

  private async handleRenegotiateAnswer(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    if (envelope.payload.type !== 'renegotiate_answer') return;
    if (entry.pc.signalingState !== 'have-local-offer') return;

    await entry.pc.setRemoteDescription(new RTCSessionDescription(envelope.payload.sdp));
    await this.flushPendingIce(entry);
  }

  private async handleRenegotiateIce(
    entry: PeerEntry,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    if (envelope.payload.type !== 'renegotiate_ice') return;

    if (!entry.pc.remoteDescription) {
      entry.pendingIce.push(envelope.payload.candidate);
      return;
    }

    await this.addIceSafely(entry.pc, envelope.payload.candidate);
  }

  async renegotiatePeer(remotePeerIdSafe: string): Promise<void> {
    const entry = this.peers.get(remotePeerIdSafe);
    if (!entry || entry.pc.connectionState === 'closed') return;
    if (entry.makingOffer || entry.pc.signalingState !== 'stable') {
      entry.pendingRenegotiation = true;
      return;
    }

    entry.pendingRenegotiation = false;
    entry.makingOffer = true;
    try {
      const offer = await entry.pc.createOffer();
      await entry.pc.setLocalDescription(offer);
      if (!entry.pc.localDescription) return;

      const sdp = entry.pc.localDescription.toJSON();
      const sentOverDc = this.sendDataChannelMessage(
        entry.peerIdSafe,
        { type: 'renegotiate_offer', fromPeerIdSafe: this.localPeerIdSafe, sdp },
        entry.sessionToken
      );

      if (!sentOverDc) {
        await this.callbacks.onSignalOffer?.(entry.peerIdSafe, sdp, entry.sessionToken);
      }
    } finally {
      entry.makingOffer = false;
    }
  }

  async renegotiateAllPeers(): Promise<void> {
    for (const peerId of Array.from(this.peers.keys())) {
      await this.renegotiatePeer(peerId);
    }
  }

  closePeer(remotePeerIdSafe: string): void {
    const entry = this.peers.get(remotePeerIdSafe);
    this.expectedTokens.delete(remotePeerIdSafe);
    if (!entry) return;

    entry.dataChannel?.close();
    entry.pc.close();
    this.peers.delete(remotePeerIdSafe);
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
