export type TelemetryConsentState = 'unset' | 'granted' | 'denied';
export type StreamFpsOption = 30 | 60;
export type RoomRole = 'owner' | 'guest';
export type KnockStatus = 'idle' | 'knocking' | 'accepted' | 'rejected' | 'timeout';
export type WatchLayoutMode = 'grid' | 'spotlight' | 'fullscreen';
export type ScreenMode = 'multi-stream' | 'friend-hubs' | 'nickname' | 'left-hub';
export type HubLiveState = 'broadcasting' | 'online' | 'offline';
export type ConnectionFailureStage =
  | 'signaling_broker'
  | 'sdp_handshake'
  | 'ice_negotiation'
  | 'peer_disconnected'
  | 'screen_capture';

export interface ConnectionFailureDto {
  stage: ConnectionFailureStage;
  reason: string;
  details?: string;
  peerIdSafe?: string;
  timestamp: number;
}

export interface AvatarOption {
  id: string;
  name: string;
  label: string;
  url: string;
}

export interface UserProfile {
  nickname: string;
  peerTag: string;
  avatarUrl: string;
  avatarName: string;
  telemetryConsent?: TelemetryConsentState;
  preferredFps?: StreamFpsOption;
  machineHash?: string;
}

export interface ProfileRowDto {
  machineHash: string;
  peerTag: string;
  nickname: string;
  avatarUrl: string;
  telemetryConsent: TelemetryConsentState;
  preferredFps: StreamFpsOption;
  updatedAt: number;
}

export interface FriendHubRecordDto {
  hubId: string;
  ownerNickname: string;
  ownerTag: string;
  ownerAvatar: string;
  lastJoinedAt: number;
  isFavorite: boolean;
}

export interface FriendHubLiveStatusDto {
  hubId: string;
  status: HubLiveState;
  peers: number;
  streamerNames: string[];
  latencyMs: number;
  updatedAt: number;
}

export interface FriendHubViewModel {
  hubId: string;
  ownerNickname: string;
  ownerTag: string;
  ownerAvatar: string;
  lastJoinedAt: number;
  isFavorite: boolean;
  status: HubLiveState;
  peers: number;
  streamerNames: string[];
  latencyMs: number;
}

export interface PendingKnock {
  id: string;
  peerTag: string;
  peerIdSafe: string;
  displayName: string;
  avatarUrl?: string;
  timestamp: number;
  hubTopic: string;
}

export interface RoomPeerDto {
  peerIdSafe: string;
  peerTag: string;
  displayName: string;
  avatarUrl: string;
  role: RoomRole;
  isStreaming: boolean;
  joinedAt: number;
}

export interface StreamItem {
  id: string;
  peerIdSafe: string;
  name: string;
  tag: string;
  resolution: string;
  fps: StreamFpsOption;
  avatarUrl: string;
  isLive: boolean;
  volume: number;
  isLocal: boolean;
  mediaStream: MediaStream | null;
  previewImage?: string;
}

export interface HostResourceMetricsDto {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  highLoadWarning: boolean;
}

export interface SystemMetricsDto {
  cpuUsagePercent: number;
  memoryUsedMb: number;
  memoryTotalMb: number;
  highLoadWarning: boolean;
  outboundFps: number;
  inboundFps: number;
  droppedFrames: number;
  rttMs: number;
}

export interface ActiveMinimizedHubDto {
  hubId: string;
  role: RoomRole;
  activeStreamsCount: number;
  isSharing: boolean;
  minimizedAt: number;
}

export type TelemetryEventName =
  | 'app_opened'
  | 'room_joined'
  | 'stream_started'
  | 'stream_stopped'
  | 'fps_changed'
  | 'high_load_detected'
  | 'knock_accepted';

export interface TelemetryEventParams {
  role?: RoomRole;
  fps?: StreamFpsOption;
  peerCountTier?: string;
  cpuTier?: string;
  ramTier?: string;
  rttBucket?: string;
}

export interface TelemetryEventDto {
  name: TelemetryEventName;
  params: TelemetryEventParams;
  timestamp: number;
}

export interface HubStatusRequestPayload {
  type: 'hub_status_request';
  requesterIdSafe: string;
  replyTopic: string;
  requestId: string;
}

export interface HubStatusResponsePayload {
  type: 'hub_status_response';
  requestId: string;
  hubId: string;
  status: HubLiveState;
  peers: number;
  streamerNames: string[];
  respondedAt: number;
}

export interface KnockRequestPayload {
  type: 'knock_request';
  peerTag: string;
  peerIdSafe: string;
  displayName: string;
  avatarUrl: string;
  replyTopic: string;
}

export interface KnockDecisionPayload {
  type: 'knock_decision';
  accepted: boolean;
  sessionToken: string;
  peerRoster: RoomPeerDto[];
  hostPeerIdSafe: string;
  hostDisplayName: string;
  reason?: string;
}

export interface WebRtcOfferPayload {
  type: 'webrtc_offer';
  sessionToken: string;
  fromPeerIdSafe: string;
  replyTopic: string;
  sdp: RTCSessionDescriptionInit;
}

export interface WebRtcAnswerPayload {
  type: 'webrtc_answer';
  sessionToken: string;
  fromPeerIdSafe: string;
  sdp: RTCSessionDescriptionInit;
}

export interface WebRtcIcePayload {
  type: 'webrtc_ice';
  sessionToken: string;
  fromPeerIdSafe: string;
  candidate: RTCIceCandidateInit;
}

export type SignalingPayload =
  | HubStatusRequestPayload
  | HubStatusResponsePayload
  | KnockRequestPayload
  | KnockDecisionPayload
  | WebRtcOfferPayload
  | WebRtcAnswerPayload
  | WebRtcIcePayload
  | PeerLeftPayload;

export type SignalingMessageType = SignalingPayload['type'];

export interface SignalingEnvelopeDto<T extends SignalingPayload = SignalingPayload> {
  version: 1;
  messageId: string;
  hubId: string;
  senderPeerIdSafe: string;
  sentAt: number;
  payload: T;
}

export interface PeerRosterSyncPayload {
  type: 'peer_roster_sync';
  peers: RoomPeerDto[];
}

export interface StreamStartedPayload {
  type: 'stream_started';
  peerIdSafe: string;
  displayName: string;
  avatarUrl: string;
  resolution: string;
  fps: StreamFpsOption;
}

export interface StreamStoppedPayload {
  type: 'stream_stopped';
  peerIdSafe: string;
}

export interface PeerProfileUpdatedPayload {
  type: 'peer_profile_updated';
  peerIdSafe: string;
  displayName: string;
  avatarUrl: string;
}

export interface RenegotiateOfferPayload {
  type: 'renegotiate_offer';
  fromPeerIdSafe: string;
  sdp: RTCSessionDescriptionInit;
}

export interface RenegotiateAnswerPayload {
  type: 'renegotiate_answer';
  fromPeerIdSafe: string;
  sdp: RTCSessionDescriptionInit;
}

export interface RenegotiateIcePayload {
  type: 'renegotiate_ice';
  fromPeerIdSafe: string;
  candidate: RTCIceCandidateInit;
}

export interface PeerLeftPayload {
  type: 'peer_left';
  peerIdSafe: string;
}

export interface PingPayload {
  type: 'ping';
  sentAt: number;
}

export interface PongPayload {
  type: 'pong';
  echoSentAt: number;
  respondedAt: number;
}

export type DataChannelPayload =
  | PeerRosterSyncPayload
  | StreamStartedPayload
  | StreamStoppedPayload
  | PeerProfileUpdatedPayload
  | RenegotiateOfferPayload
  | RenegotiateAnswerPayload
  | RenegotiateIcePayload
  | PeerLeftPayload
  | PingPayload
  | PongPayload;

export type DataChannelMessageType = DataChannelPayload['type'];

export interface DataChannelEnvelopeDto<T extends DataChannelPayload = DataChannelPayload> {
  version: 1;
  sessionToken: string;
  senderPeerIdSafe: string;
  sentAt: number;
  payload: T;
}

export type LocalWindowBusMessage =
  | { type: 'profile_updated'; profile: UserProfile }
  | { type: 'minimized_hub_updated'; hub: ActiveMinimizedHubDto }
  | { type: 'minimized_hub_cleared'; hubId: string }
  | { type: 'restore_hub_requested'; hubId: string }
  | { type: 'disconnect_hub_requested'; hubId: string };

export type LocalWindowBusMessageType = LocalWindowBusMessage['type'];
