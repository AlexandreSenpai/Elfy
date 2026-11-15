import { STREAM_CONFIG } from '../../domain/config';
import { StreamFpsOption, StreamResolutionPreset } from '../../domain/dtos';
import { PeerEntry } from './peerTypes';
import { SdpVideoBitrateHints } from './sdpBitrate';

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

const getViewerScaleFactor = (remotePeerCount: number): number => {
  if (remotePeerCount <= 1) return STREAM_CONFIG.MESH_BITRATE_SCALE_BY_VIEWERS[1];
  if (remotePeerCount === 2) return STREAM_CONFIG.MESH_BITRATE_SCALE_BY_VIEWERS[2];
  if (remotePeerCount === 3) return STREAM_CONFIG.MESH_BITRATE_SCALE_BY_VIEWERS[3];
  return STREAM_CONFIG.MESH_BITRATE_SCALE_BY_VIEWERS.MANY;
};

/** Computes per-peer video bitrate budget (bps) scaled by resolution, FPS, viewer count, and CPU load. */
export const computeTargetBitrateBps = (
  resolution: StreamResolutionPreset,
  fps: StreamFpsOption,
  remotePeerCount: number,
  cpuThrottleFactor = 1.0
): number => {
  const baseBps = STREAM_CONFIG.MAX_BITRATE_BPS[resolution][fps];
  const viewerScale = getViewerScaleFactor(Math.max(1, remotePeerCount));
  const clampedThrottle = Math.max(0.5, Math.min(1.0, cpuThrottleFactor));
  return Math.max(
    STREAM_CONFIG.MIN_VIDEO_BITRATE_BPS,
    Math.round(baseBps * viewerScale * clampedThrottle)
  );
};

const buildVideoConstraints = (
  fps: StreamFpsOption,
  resolution: StreamResolutionPreset
): MediaTrackConstraints => {
  const dims = STREAM_CONFIG.RESOLUTION_DIMENSIONS[resolution];
  if (!dims) {
    return { frameRate: { ideal: fps, max: fps } };
  }
  return {
    frameRate: { ideal: fps, max: fps },
    width: { ideal: dims.width, max: dims.width },
    height: { ideal: dims.height, max: dims.height },
  };
};

const applyContentHint = (stream: MediaStream): void => {
  for (const videoTrack of stream.getVideoTracks()) {
    if ('contentHint' in videoTrack) {
      videoTrack.contentHint = STREAM_CONFIG.CONTENT_HINT;
    }
  }
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

const updateSenderEncodingParams = async (
  sender: RTCRtpSender,
  fps: StreamFpsOption,
  maxBitrateBps: number
): Promise<void> => {
  if (sender.track?.kind !== 'video') return;
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    params.degradationPreference = 'maintain-framerate';
    params.encodings[0].maxFramerate = fps;
    params.encodings[0].maxBitrate = maxBitrateBps;
    await sender.setParameters(params);
  } catch {
    // Some synthetic/headless browser implementations restrict setParameters on canvas tracks.
  }
};

/**
 * Owns local screen capture (or synthetic test canvas capture), dynamic FPS/resolution
 * constraints, gaming encoder hints, bitrate budgets, and sender attachment onto peers.
 */
export class CaptureManager {
  private localStream: MediaStream | null = null;
  private currentFps: StreamFpsOption = STREAM_CONFIG.DEFAULT_FPS;
  private currentResolution: StreamResolutionPreset = STREAM_CONFIG.DEFAULT_RESOLUTION;
  private cpuThrottleFactor = 1.0;
  private syntheticCtrl: SyntheticStreamController | null = null;

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getCurrentFps(): StreamFpsOption {
    return this.currentFps;
  }

  getCurrentResolution(): StreamResolutionPreset {
    return this.currentResolution;
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

    const stream = canvas.captureStream(fps);
    applyContentHint(stream);
    return stream;
  }

  private stopSyntheticController(): void {
    if (!this.syntheticCtrl) return;
    window.clearInterval(this.syntheticCtrl.timerId);
    this.syntheticCtrl = null;
  }

  private async acquireCaptureStream(
    fps: StreamFpsOption,
    resolution: StreamResolutionPreset
  ): Promise<MediaStream> {
    const win = window as ElfyMediaTestWindow;
    if (win.__ELFY_TEST_STREAM__) {
      applyContentHint(win.__ELFY_TEST_STREAM__);
      return win.__ELFY_TEST_STREAM__;
    }

    const canDisplayCapture = Boolean(navigator.mediaDevices?.getDisplayMedia);
    if (win.__ELFY_FORCE_SYNTHETIC_STREAM__ || !canDisplayCapture) {
      return this.createSyntheticStream(fps);
    }

    const videoConstraints = buildVideoConstraints(fps, resolution);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: videoConstraints,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
      applyContentHint(stream);
      return stream;
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === 'OverconstrainedError' || err.name === 'TypeError')
      ) {
        try {
          const fallbackStream = await navigator.mediaDevices.getDisplayMedia({
            video: videoConstraints,
            audio: true,
          });
          applyContentHint(fallbackStream);
          return fallbackStream;
        } catch (fallbackErr) {
          if (navigator.webdriver && win.__ELFY_FORCE_SYNTHETIC_STREAM__ !== false) {
            return this.createSyntheticStream(fps);
          }
          throw fallbackErr;
        }
      }

      if (navigator.webdriver && win.__ELFY_FORCE_SYNTHETIC_STREAM__ !== false) {
        return this.createSyntheticStream(fps);
      }
      throw err;
    }
  }

  async startScreenCapture(
    getPeers: () => Iterable<PeerEntry>,
    fps?: StreamFpsOption,
    resolution?: StreamResolutionPreset
  ): Promise<MediaStream> {
    const targetFps = fps ?? this.currentFps;
    const targetResolution = resolution ?? this.currentResolution;
    this.currentFps = targetFps;
    this.currentResolution = targetResolution;
    this.cpuThrottleFactor = 1.0;

    const existingVideo = this.localStream?.getVideoTracks()[0];
    if (this.localStream && existingVideo && existingVideo.readyState === 'live') {
      await this.setStreamFps(getPeers(), targetFps);
      await this.setStreamResolution(getPeers(), targetResolution);
      return this.localStream;
    }

    if (this.localStream) {
      await this.stopScreenCapture(getPeers());
    }

    const stream = await this.acquireCaptureStream(targetFps, targetResolution);
    this.localStream = stream;

    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.onended = () => {
        void this.stopScreenCapture(getPeers());
      };
    }

    const peerList = Array.from(getPeers());
    for (const entry of peerList) {
      await this.attachLocalTracksToPeer(entry, stream);
      await this.applyEncodingToPeerSenders(entry, peerList.length);
    }

    return stream;
  }

  async stopScreenCapture(peers: Iterable<PeerEntry>): Promise<void> {
    const stream = this.localStream;
    this.localStream = null;
    this.cpuThrottleFactor = 1.0;
    this.stopSyntheticController();

    if (stream) {
      for (const track of stream.getTracks()) {
        track.stop();
      }
    }

    for (const entry of peers) {
      this.removeLocalSenders(entry, stream);
    }
  }

  removeLocalSenders(entry: PeerEntry, oldStream: MediaStream | null): void {
    if (!oldStream || entry.pc.connectionState === 'closed') return;
    const oldTrackIds = new Set(oldStream.getTracks().map((t) => t.id));
    for (const sender of entry.pc.getSenders()) {
      if (sender.track && oldTrackIds.has(sender.track.id)) {
        entry.pc.removeTrack(sender);
      }
    }
  }

  async attachLocalTracksToPeer(
    entry: PeerEntry,
    stream: MediaStream | null = this.localStream
  ): Promise<void> {
    if (!stream || entry.pc.connectionState === 'closed') return;
    const transceivers = entry.pc.getTransceivers();

    for (const track of stream.getTracks()) {
      if (track.readyState === 'ended') continue;

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
        continue;
      }

      const existingSender = entry.pc.getSenders().find((s) => s.track?.kind === track.kind);
      if (existingSender) {
        await existingSender.replaceTrack(track);
        continue;
      }

      if (entry.pc.signalingState === 'have-remote-offer') {
        continue;
      }

      entry.pc.addTrack(track, stream);
    }
  }

  hasActiveLocalVideo(): boolean {
    return Boolean(
      this.localStream?.getVideoTracks().some((track) => track.readyState === 'live')
    );
  }

  getVideoBitrateHints(activeRemotePeerCount: number): SdpVideoBitrateHints {
    const targetBps = computeTargetBitrateBps(
      this.currentResolution,
      this.currentFps,
      activeRemotePeerCount,
      this.cpuThrottleFactor
    );
    const targetKbps = Math.max(1, Math.round(targetBps / 1000));
    const minKbps = Math.min(
      targetKbps,
      Math.round(STREAM_CONFIG.MIN_VIDEO_BITRATE_BPS / 1000)
    );
    const startKbps = Math.max(
      minKbps,
      Math.round(targetKbps * STREAM_CONFIG.SDP_BITRATE_START_FACTOR)
    );
    const maxKbps = Math.max(STREAM_CONFIG.SDP_BITRATE_MAX_CEILING_KBPS, targetKbps);
    return { startKbps, minKbps, maxKbps };
  }

  async applyEncodingToPeerSenders(
    entry: PeerEntry,
    activeRemotePeerCount: number
  ): Promise<void> {
    if (entry.pc.connectionState === 'closed') return;
    const targetBitrateBps = computeTargetBitrateBps(
      this.currentResolution,
      this.currentFps,
      activeRemotePeerCount,
      this.cpuThrottleFactor
    );

    for (const sender of entry.pc.getSenders()) {
      await updateSenderEncodingParams(sender, this.currentFps, targetBitrateBps);
    }
  }

  async refreshAllPeerSenders(peers: Iterable<PeerEntry>): Promise<void> {
    const peerList = Array.from(peers);
    const peerCount = peerList.length;
    for (const entry of peerList) {
      await this.applyEncodingToPeerSenders(entry, peerCount);
    }
  }

  async setCpuThrottleFactor(peers: Iterable<PeerEntry>, factor: number): Promise<void> {
    const clamped = Math.max(0.5, Math.min(1.0, factor));
    if (Math.abs(clamped - this.cpuThrottleFactor) < 0.02) return;
    this.cpuThrottleFactor = clamped;
    await this.refreshAllPeerSenders(peers);
  }

  hasNegotiatedLocalStream(entry: PeerEntry): boolean {
    if (!this.localStream) return true;
    const liveTracks = this.localStream.getTracks().filter((t) => t.readyState === 'live');
    if (liveTracks.length === 0) return true;
    const transceivers = entry.pc.getTransceivers();
    return liveTracks.every((track) =>
      transceivers.some(
        (t) =>
          t.direction !== 'stopped' &&
          t.currentDirection !== 'stopped' &&
          t.sender.track?.id === track.id &&
          (t.currentDirection === 'sendrecv' || t.currentDirection === 'sendonly')
      )
    );
  }

  private async replaceVideoTrackOnStreamAndPeers(
    peers: PeerEntry[],
    oldTrack: MediaStreamTrack,
    newTrack: MediaStreamTrack
  ): Promise<void> {
    if (!this.localStream) return;
    if ('contentHint' in newTrack) {
      newTrack.contentHint = STREAM_CONFIG.CONTENT_HINT;
    }
    this.localStream.removeTrack(oldTrack);
    this.localStream.addTrack(newTrack);
    oldTrack.stop();

    const targetBitrateBps = computeTargetBitrateBps(
      this.currentResolution,
      this.currentFps,
      peers.length,
      this.cpuThrottleFactor
    );
    for (const entry of peers) {
      const sender = entry.pc.getSenders().find((s) => s.track?.kind === 'video');
      if (!sender) continue;
      await sender.replaceTrack(newTrack);
      await updateSenderEncodingParams(sender, this.currentFps, targetBitrateBps);
    }
  }

  async setStreamFps(peers: Iterable<PeerEntry>, fps: StreamFpsOption): Promise<void> {
    this.currentFps = fps;
    const peerList = Array.from(peers);

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
      await this.applyTrackConstraints(peerList, videoTrack, fps, this.currentResolution);
    }

    await this.refreshAllPeerSenders(peerList);
  }

  async setStreamResolution(
    peers: Iterable<PeerEntry>,
    resolution: StreamResolutionPreset
  ): Promise<void> {
    this.currentResolution = resolution;
    const peerList = Array.from(peers);

    const videoTrack = this.localStream?.getVideoTracks()[0];
    if (videoTrack) {
      await this.applyTrackConstraints(peerList, videoTrack, this.currentFps, resolution);
    }

    await this.refreshAllPeerSenders(peerList);
  }

  private async applyTrackConstraints(
    peers: PeerEntry[],
    videoTrack: MediaStreamTrack,
    fps: StreamFpsOption,
    resolution: StreamResolutionPreset
  ): Promise<void> {
    try {
      await videoTrack.applyConstraints(buildVideoConstraints(fps, resolution));
    } catch {
      // Synthetic canvas tracks may ignore applyConstraints; handled below for FPS.
    }

    const reportedFps = videoTrack.getSettings().frameRate;
    if (!this.syntheticCtrl || reportedFps === fps) return;

    const refreshed = this.syntheticCtrl.canvas.captureStream(fps).getVideoTracks()[0];
    if (!refreshed) return;
    await this.replaceVideoTrackOnStreamAndPeers(peers, videoTrack, refreshed);
  }
}
