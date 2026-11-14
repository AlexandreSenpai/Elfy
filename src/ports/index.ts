import {
  ConnectionFailureDto,
  DataChannelEnvelopeDto,
  DataChannelPayload,
  FriendHubRecordDto,
  LocalWindowBusMessage,
  ProfileRowDto,
  SignalingEnvelopeDto,
  SignalingPayload,
  StreamFpsOption,
  SystemMetricsDto,
  TelemetryConsentState,
  TelemetryEventDto,
  TelemetryEventName,
  TelemetryEventParams,
} from '../domain/dtos';

export interface ProfileInitDefaults {
  nickname: string;
  peerTag: string;
  avatarUrl: string;
}

/** Persistence contract for SQLite (Tauri) and isolated test storage (browser). */
export interface IStorageRepository {
  getOrInitProfile(rawMachineUid: string, defaults: ProfileInitDefaults): Promise<ProfileRowDto>;
  updateProfile(
    rawMachineUid: string,
    nickname: string,
    avatarUrl: string,
    preferredFps?: StreamFpsOption
  ): Promise<ProfileRowDto>;
  setTelemetryConsent(rawMachineUid: string, consent: TelemetryConsentState): Promise<ProfileRowDto>;
  listFriendHubs(): Promise<FriendHubRecordDto[]>;
  upsertFriendHub(hub: FriendHubRecordDto): Promise<FriendHubRecordDto[]>;
  removeFriendHub(hubId: string): Promise<FriendHubRecordDto[]>;
}

export type TopicMessageHandler = (
  envelope: SignalingEnvelopeDto,
  topic: string
) => void | Promise<void>;

export type ConnectionStateListener = (connected: boolean) => void;

/** Topic-routed signaling transport over MQTT and local BroadcastChannel fallback. */
export interface ISignalingTransport {
  readonly isConnected: boolean;
  connect(): Promise<boolean>;
  subscribeTopic(topic: string, handler: TopicMessageHandler): Promise<() => void>;
  unsubscribeTopic(topic: string): Promise<void>;
  publish<T extends SignalingPayload>(
    topic: string,
    envelope: SignalingEnvelopeDto<T>
  ): Promise<boolean>;
  onConnectionChange(listener: ConnectionStateListener): () => void;
}

export interface StreamEngineCallbacks {
  onRemoteStream?: (peerIdSafe: string, stream: MediaStream) => void;
  onRemoteStreamRemoved?: (peerIdSafe: string) => void;
  onPeerConnectionStateChange?: (peerIdSafe: string, state: RTCPeerConnectionState) => void;
  onPeerConnectionError?: (failure: ConnectionFailureDto) => void;
  onDataChannelOpen?: (peerIdSafe: string) => void;
  onDataChannelMessage?: (peerIdSafe: string, message: DataChannelEnvelopeDto) => void;
  onSignalOffer?: (
    peerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ) => void | Promise<void>;
  onSignalAnswer?: (
    peerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ) => void | Promise<void>;
  onSignalIce?: (
    peerIdSafe: string,
    candidate: RTCIceCandidateInit,
    sessionToken: string
  ) => void | Promise<void>;
}

export interface WebRtcStatsSnapshot {
  outboundFps: number;
  inboundFps: number;
  droppedFrames: number;
  rttMs: number;
}

/** Bidirectional multi-peer WebRTC media and DataChannel engine. */
export interface IStreamEngine {
  configure(localPeerIdSafe: string, callbacks: StreamEngineCallbacks): void;
  registerPeerSessionToken(remotePeerIdSafe: string, sessionToken: string): void;
  startScreenCapture(fps?: StreamFpsOption): Promise<MediaStream>;
  stopScreenCapture(): Promise<void>;
  getLocalStream(): MediaStream | null;
  getRemoteStream(peerIdSafe: string): MediaStream | null;
  getCurrentFps(): StreamFpsOption;
  setStreamFps(fps: StreamFpsOption): Promise<void>;
  initiatePeerConnection(remotePeerIdSafe: string, sessionToken: string): Promise<void>;
  handleIncomingOffer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void>;
  handleIncomingAnswer(
    remotePeerIdSafe: string,
    sdp: RTCSessionDescriptionInit,
    sessionToken: string
  ): Promise<void>;
  handleIncomingIce(
    remotePeerIdSafe: string,
    candidate: RTCIceCandidateInit,
    sessionToken: string
  ): Promise<void>;
  sendDataChannelMessage<T extends DataChannelPayload>(
    remotePeerIdSafe: string,
    payload: T,
    sessionToken: string
  ): boolean;
  broadcastDataChannelMessage<T extends DataChannelPayload>(
    payload: T,
    sessionToken: string
  ): void;
  handleDataChannelRenegotiation(
    remotePeerIdSafe: string,
    envelope: DataChannelEnvelopeDto
  ): Promise<void>;
  renegotiatePeer(remotePeerIdSafe: string): Promise<void>;
  renegotiateAllPeers(): Promise<void>;
  closePeer(remotePeerIdSafe: string): void;
  closeAllPeers(): void;
  hasPeer(peerIdSafe: string): boolean;
  isPeerHealthy(peerIdSafe: string): boolean;
  pingAndCleanupPeers(): string[];
  getConnectedPeerIds(): string[];
  getStatsSnapshot(): Promise<WebRtcStatsSnapshot>;
}

/** System CPU/RAM and WebRTC FPS/RTT telemetry sampler. */
export interface ISystemMonitor {
  sampleMetrics(streamEngine?: IStreamEngine): Promise<SystemMetricsDto>;
}

/** Consent-gated anonymous performance telemetry provider. */
export interface ITelemetryProvider {
  setConsent(consent: TelemetryConsentState): void;
  getConsent(): TelemetryConsentState;
  trackEvent(name: TelemetryEventName, params?: TelemetryEventParams): Promise<boolean>;
  getRecordedEventsForTesting(): TelemetryEventDto[];
  clearRecordedEventsForTesting(): void;
}

export type LocalWindowBusHandler = (message: LocalWindowBusMessage) => void;

/** Cross-window synchronization bus over Tauri events and local BroadcastChannel. */
export interface ILocalWindowBus {
  publish(message: LocalWindowBusMessage): Promise<void>;
  subscribe(handler: LocalWindowBusHandler): () => void;
}
