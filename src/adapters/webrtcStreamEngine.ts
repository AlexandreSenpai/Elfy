import {
  DataChannelEnvelopeDto,
  DataChannelPayload,
  StreamFpsOption,
  StreamResolutionPreset,
} from '../domain/dtos';
import { IStreamEngine, StreamEngineCallbacks, WebRtcStatsSnapshot } from '../ports';
import { CaptureManager } from './webrtc/captureManager';
import { DataChannelRouter } from './webrtc/dataChannelRouter';
import { PeerNegotiator } from './webrtc/peerNegotiator';
import {
  PeerEntry,
  clearOutboundStatsSamples,
  clearStatsSampleTracker,
  createStatsSampleTracker,
  isPeerEntryConnected,
  isPeerEntryHealthy,
  prunePeerStatsSamples,
} from './webrtc/peerTypes';
import { collectWebRtcStats } from './webrtc/statsCollector';

/**
 * Facade composing capture management, peer SDP/ICE negotiation, DataChannel
 * routing/keepalives, and stats collection behind the `IStreamEngine` port.
 */
export class WebRtcStreamEngine implements IStreamEngine {
  private localPeerIdSafe = 'local_peer';
  private callbacks: StreamEngineCallbacks = {};
  private readonly peers = new Map<string, PeerEntry>();
  private readonly expectedTokens = new Map<string, string>();
  private readonly statsTracker = createStatsSampleTracker();
  private readonly captureManager = new CaptureManager();
  private readonly negotiator: PeerNegotiator;
  private readonly dcRouter: DataChannelRouter;

  constructor() {
    this.negotiator = new PeerNegotiator({
      getLocalPeerIdSafe: () => this.localPeerIdSafe,
      getCallbacks: () => this.callbacks,
      getPeers: () => this.peers,
      getExpectedTokens: () => this.expectedTokens,
      captureManager: this.captureManager,
      getDataChannelRouter: () => this.dcRouter,
    });

    this.dcRouter = new DataChannelRouter({
      getLocalPeerIdSafe: () => this.localPeerIdSafe,
      getCallbacks: () => this.callbacks,
      getPeers: () => this.peers,
      captureManager: this.captureManager,
      applyRemoteOffer: (entry, sdp, preferDataChannel) =>
        this.negotiator.applyRemoteOffer(entry, sdp, preferDataChannel),
      applyRemoteAnswer: (entry, sdp) => this.negotiator.applyRemoteAnswer(entry, sdp),
      applyRemoteIce: (entry, candidate) => this.negotiator.applyRemoteIce(entry, candidate),
      syncPeerWithLocalStream: (entry) => this.negotiator.syncPeerWithLocalStream(entry),
      closePeer: (remotePeerIdSafe) => this.negotiator.closePeer(remotePeerIdSafe),
    });
  }

  configure(localPeerIdSafe: string, callbacks: StreamEngineCallbacks): void {
    this.localPeerIdSafe = localPeerIdSafe || 'local_peer';
    this.callbacks = callbacks;
  }

  registerPeerSessionToken(remotePeerIdSafe: string, sessionToken: string): void {
    this.negotiator.registerPeerSessionToken(remotePeerIdSafe, sessionToken);
  }

  startScreenCapture(
    fps?: StreamFpsOption,
    resolution?: StreamResolutionPreset
  ): Promise<MediaStream> {
    clearOutboundStatsSamples(this.statsTracker);
    return this.captureManager.startScreenCapture(() => this.peers.values(), fps, resolution);
  }

  stopScreenCapture(): Promise<void> {
    clearOutboundStatsSamples(this.statsTracker);
    return this.captureManager.stopScreenCapture(this.peers.values());
  }

  getLocalStream(): MediaStream | null {
    return this.captureManager.getLocalStream();
  }

  getRemoteStream(peerIdSafe: string): MediaStream | null {
    return this.peers.get(peerIdSafe)?.remoteStream ?? null;
  }

  getCurrentFps(): StreamFpsOption {
    return this.captureManager.getCurrentFps();
  }

  setStreamFps(fps: StreamFpsOption): Promise<void> {
    return this.captureManager.setStreamFps(this.peers.values(), fps);
  }

  getCurrentResolution(): StreamResolutionPreset {
    return this.captureManager.getCurrentResolution();
  }

  setStreamResolution(resolution: StreamResolutionPreset): Promise<void> {
    return this.captureManager.setStreamResolution(this.peers.values(), resolution);
  }

  refreshSenderEncodingParams(): Promise<void> {
    return this.captureManager.refreshAllPeerSenders(this.peers.values());
  }

  setCpuThrottleFactor(factor: number): Promise<void> {
    return this.captureManager.setCpuThrottleFactor(this.peers.values(), factor);
  }

  initiatePeerConnection(remotePeerIdSafe: string, sessionToken: string): Promise<void> {
    return this.negotiator.initiatePeerConnection(remotePeerIdSafe, sessionToken);
  }

  handleIncomingOffer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    return this.negotiator.handleIncomingOffer(remotePeerIdSafe, sdp, sessionToken);
  }

  handleIncomingAnswer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void> {
    return this.negotiator.handleIncomingAnswer(remotePeerIdSafe, sdp, sessionToken);
  }

  handleIncomingIce(
    remotePeerIdSafe: string,
    candidate: RTCIceCandidateInit,
    sessionToken: string
  ): Promise<void> {
    return this.negotiator.handleIncomingIce(remotePeerIdSafe, candidate, sessionToken);
  }

  sendDataChannelMessage<T extends DataChannelPayload>(
    remotePeerIdSafe: string,
    payload: T,
    sessionToken: string
  ): boolean {
    return this.dcRouter.sendMessage(remotePeerIdSafe, payload, sessionToken);
  }

  broadcastDataChannelMessage<T extends DataChannelPayload>(
    payload: T,
    sessionToken: string
  ): void {
    this.dcRouter.broadcastMessage(payload, sessionToken);
  }

  handleDataChannelRenegotiation(
    remotePeerIdSafe: string,
    envelope: DataChannelEnvelopeDto
  ): Promise<void> {
    return this.dcRouter.handleRenegotiation(remotePeerIdSafe, envelope);
  }

  renegotiatePeer(remotePeerIdSafe: string): Promise<void> {
    return this.negotiator.renegotiatePeer(remotePeerIdSafe);
  }

  renegotiateAllPeers(): Promise<void> {
    return this.negotiator.renegotiateAllPeers();
  }

  closePeer(remotePeerIdSafe: string): void {
    prunePeerStatsSamples(this.statsTracker, remotePeerIdSafe);
    this.negotiator.closePeer(remotePeerIdSafe);
  }

  closeAllPeers(): void {
    clearStatsSampleTracker(this.statsTracker);
    this.negotiator.closeAllPeers();
  }

  hasPeer(peerIdSafe: string): boolean {
    return this.peers.has(peerIdSafe);
  }

  isPeerHealthy(peerIdSafe: string): boolean {
    return isPeerEntryHealthy(this.peers.get(peerIdSafe));
  }

  isPeerConnected(peerIdSafe: string): boolean {
    return isPeerEntryConnected(this.peers.get(peerIdSafe));
  }

  pingAndCleanupPeers(): string[] {
    return this.dcRouter.pingAndCleanupPeers();
  }

  getConnectedPeerIds(): string[] {
    return Array.from(this.peers.keys());
  }

  getStatsSnapshot(): Promise<WebRtcStatsSnapshot> {
    return collectWebRtcStats(this.peers.values(), this.statsTracker);
  }
}

export const webrtcStreamEngine: IStreamEngine = new WebRtcStreamEngine();
