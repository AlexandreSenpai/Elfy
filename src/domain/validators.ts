import { ROOM_CONFIG } from './config';
import {
  ActiveMinimizedHubDto,
  DataChannelEnvelopeDto,
  DataChannelMessageType,
  DataChannelPayload,
  HubLiveState,
  LocalWindowBusMessage,
  LocalWindowBusMessageType,
  PeerKickedPayload,
  RoomPeerDto,
  RoomRole,
  SignalingEnvelopeDto,
  SignalingMessageType,
  SignalingPayload,
  StreamFpsOption,
  StreamResolutionPreset,
  TelemetryConsentState,
  UserProfile,
} from './dtos';
import { normalizeHubTopic } from '../utils/hubTopics';

const textDecoder = new TextDecoder();

/** Checks whether an unknown value is a non-null plain record. */
export const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null) return false;
  return !Array.isArray(value);
};

const isNonEmptyString = (value: unknown): value is string => {
  return typeof value === 'string' && value.trim().length > 0;
};

const isString = (value: unknown): value is string => {
  return typeof value === 'string';
};

const isFiniteNumber = (value: unknown): value is number => {
  return typeof value === 'number' && Number.isFinite(value);
};

const isBoolean = (value: unknown): value is boolean => {
  return typeof value === 'boolean';
};

const isStreamFps = (value: unknown): value is StreamFpsOption => {
  return value === 30 || value === 60 || value === 120;
};

export const isStreamResolutionPreset = (value: unknown): value is StreamResolutionPreset => {
  return value === '720p' || value === '1080p' || value === 'source';
};

const isRoomRole = (value: unknown): value is RoomRole => {
  return value === 'owner' || value === 'guest';
};

const isHubLiveState = (value: unknown): value is HubLiveState => {
  return value === 'broadcasting' || value === 'online' || value === 'offline';
};

export const isTelemetryConsentState = (value: unknown): value is TelemetryConsentState => {
  return value === 'unset' || value === 'granted' || value === 'denied';
};

const parseJsonInput = (raw: unknown): unknown => {
  if (raw instanceof Uint8Array) {
    try {
      return JSON.parse(textDecoder.decode(raw));
    } catch {
      return null;
    }
  }

  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  return raw;
};

const parseStringArray = (value: unknown): string[] | null => {
  if (!Array.isArray(value)) return null;
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    result.push(item);
  }
  return result;
};

const parseRoomPeer = (value: unknown): RoomPeerDto | null => {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.peerIdSafe)) return null;
  if (!isNonEmptyString(value.peerTag)) return null;
  if (!isNonEmptyString(value.displayName)) return null;
  if (!isString(value.avatarUrl)) return null;
  if (!isRoomRole(value.role)) return null;
  if (!isBoolean(value.isStreaming)) return null;
  if (!isFiniteNumber(value.joinedAt)) return null;

  return {
    peerIdSafe: value.peerIdSafe,
    peerTag: value.peerTag,
    displayName: value.displayName,
    avatarUrl: value.avatarUrl,
    role: value.role,
    isStreaming: value.isStreaming,
    joinedAt: value.joinedAt,
  };
};

const parseRoomPeerArray = (value: unknown): RoomPeerDto[] | null => {
  if (!Array.isArray(value)) return null;
  const peers: RoomPeerDto[] = [];
  for (const item of value) {
    const parsed = parseRoomPeer(item);
    if (!parsed) return null;
    peers.push(parsed);
  }
  return peers;
};

const VALID_SDP_TYPES = new Set<RTCSdpType>(['offer', 'answer', 'pranswer', 'rollback']);

const parseSdpInit = (value: unknown): RTCSessionDescriptionInit | null => {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.type) || !VALID_SDP_TYPES.has(value.type as RTCSdpType)) return null;
  if (value.type !== 'rollback' && !isString(value.sdp)) return null;

  return {
    type: value.type as RTCSdpType,
    sdp: isString(value.sdp) ? value.sdp : undefined,
  };
};

const parseIceCandidateInit = (value: unknown): RTCIceCandidateInit | null => {
  if (!isRecord(value)) return null;
  if (!isString(value.candidate)) return null;

  return {
    candidate: value.candidate,
    sdpMid: isString(value.sdpMid) || value.sdpMid === null ? value.sdpMid : undefined,
    sdpMLineIndex:
      isFiniteNumber(value.sdpMLineIndex) || value.sdpMLineIndex === null
        ? value.sdpMLineIndex
        : undefined,
    usernameFragment:
      isString(value.usernameFragment) || value.usernameFragment === null
        ? value.usernameFragment
        : undefined,
  };
};

type SignalingPayloadParser = (p: Record<string, unknown>) => SignalingPayload | null;

const parsePeerKickedPayload = (p: Record<string, unknown>): PeerKickedPayload | null => {
  if (!isNonEmptyString(p.peerIdSafe)) return null;
  return {
    type: 'peer_kicked',
    peerIdSafe: p.peerIdSafe,
    reason: isString(p.reason) ? p.reason : undefined,
  };
};

const SIGNALING_PAYLOAD_PARSERS: Record<SignalingMessageType, SignalingPayloadParser> = {
  hub_status_request: (p) => {
    if (!isNonEmptyString(p.requesterIdSafe)) return null;
    if (!isNonEmptyString(p.replyTopic)) return null;
    if (!isNonEmptyString(p.requestId)) return null;
    return {
      type: 'hub_status_request',
      requesterIdSafe: p.requesterIdSafe,
      replyTopic: p.replyTopic,
      requestId: p.requestId,
    };
  },
  hub_status_response: (p) => {
    if (!isNonEmptyString(p.requestId)) return null;
    if (!isNonEmptyString(p.hubId)) return null;
    if (!isHubLiveState(p.status)) return null;
    if (!isFiniteNumber(p.peers)) return null;
    if (!isFiniteNumber(p.respondedAt)) return null;
    const streamerNames = parseStringArray(p.streamerNames);
    if (!streamerNames) return null;
    return {
      type: 'hub_status_response',
      requestId: p.requestId,
      hubId: p.hubId,
      status: p.status,
      peers: p.peers,
      streamerNames,
      respondedAt: p.respondedAt,
    };
  },
  knock_request: (p) => {
    if (!isNonEmptyString(p.peerTag)) return null;
    if (!isNonEmptyString(p.peerIdSafe)) return null;
    if (!isNonEmptyString(p.displayName)) return null;
    if (!isString(p.avatarUrl)) return null;
    if (!isNonEmptyString(p.replyTopic)) return null;
    return {
      type: 'knock_request',
      peerTag: p.peerTag,
      peerIdSafe: p.peerIdSafe,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      replyTopic: p.replyTopic,
    };
  },
  knock_decision: (p) => {
    if (!isBoolean(p.accepted)) return null;
    if (!isString(p.sessionToken)) return null;
    if (p.accepted && !isNonEmptyString(p.sessionToken)) return null;
    if (!isNonEmptyString(p.hostPeerIdSafe)) return null;
    if (!isNonEmptyString(p.hostDisplayName)) return null;
    const peerRoster = parseRoomPeerArray(p.peerRoster);
    if (!peerRoster) return null;
    return {
      type: 'knock_decision',
      accepted: p.accepted,
      sessionToken: p.sessionToken,
      peerRoster,
      hostPeerIdSafe: p.hostPeerIdSafe,
      hostDisplayName: p.hostDisplayName,
      reason: isString(p.reason) ? p.reason : undefined,
    };
  },
  webrtc_offer: (p) => {
    if (!isNonEmptyString(p.sessionToken)) return null;
    if (!isNonEmptyString(p.fromPeerIdSafe)) return null;
    if (!isNonEmptyString(p.replyTopic)) return null;
    const sdp = parseSdpInit(p.sdp);
    if (!sdp) return null;
    return {
      type: 'webrtc_offer',
      sessionToken: p.sessionToken,
      fromPeerIdSafe: p.fromPeerIdSafe,
      replyTopic: p.replyTopic,
      sdp,
    };
  },
  webrtc_answer: (p) => {
    if (!isNonEmptyString(p.sessionToken)) return null;
    if (!isNonEmptyString(p.fromPeerIdSafe)) return null;
    const sdp = parseSdpInit(p.sdp);
    if (!sdp) return null;
    return {
      type: 'webrtc_answer',
      sessionToken: p.sessionToken,
      fromPeerIdSafe: p.fromPeerIdSafe,
      sdp,
    };
  },
  webrtc_ice: (p) => {
    if (!isNonEmptyString(p.sessionToken)) return null;
    if (!isNonEmptyString(p.fromPeerIdSafe)) return null;
    const candidate = parseIceCandidateInit(p.candidate);
    if (!candidate) return null;
    return {
      type: 'webrtc_ice',
      sessionToken: p.sessionToken,
      fromPeerIdSafe: p.fromPeerIdSafe,
      candidate,
    };
  },
  peer_left: (p) => {
    if (!isNonEmptyString(p.peerIdSafe)) return null;
    return { type: 'peer_left', peerIdSafe: p.peerIdSafe };
  },
  peer_kicked: parsePeerKickedPayload,
};

/** Validates and parses a raw MQTT/BroadcastChannel signaling envelope. */
export const parseSignalingEnvelope = (raw: unknown): SignalingEnvelopeDto | null => {
  const data = parseJsonInput(raw);
  if (!isRecord(data)) return null;
  if (data.version !== 1) return null;
  if (!isNonEmptyString(data.messageId)) return null;
  if (!isNonEmptyString(data.hubId)) return null;
  if (!isNonEmptyString(data.senderPeerIdSafe)) return null;
  if (!isFiniteNumber(data.sentAt)) return null;
  if (!isRecord(data.payload) || !isNonEmptyString(data.payload.type)) return null;

  const parser = SIGNALING_PAYLOAD_PARSERS[data.payload.type as SignalingMessageType];
  if (!parser) return null;

  const payload = parser(data.payload);
  if (!payload) return null;

  return {
    version: 1,
    messageId: data.messageId,
    hubId: data.hubId,
    senderPeerIdSafe: data.senderPeerIdSafe,
    sentAt: data.sentAt,
    payload,
  };
};

type DataChannelPayloadParser = (p: Record<string, unknown>) => DataChannelPayload | null;

const DATA_CHANNEL_PAYLOAD_PARSERS: Record<DataChannelMessageType, DataChannelPayloadParser> = {
  peer_roster_sync: (p) => {
    const peers = parseRoomPeerArray(p.peers);
    if (!peers) return null;
    return { type: 'peer_roster_sync', peers };
  },
  stream_started: (p) => {
    if (!isNonEmptyString(p.peerIdSafe)) return null;
    if (!isNonEmptyString(p.displayName)) return null;
    if (!isString(p.avatarUrl)) return null;
    if (!isNonEmptyString(p.resolution)) return null;
    if (!isStreamFps(p.fps)) return null;
    return {
      type: 'stream_started',
      peerIdSafe: p.peerIdSafe,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
      resolution: p.resolution,
      fps: p.fps,
    };
  },
  stream_stopped: (p) => {
    if (!isNonEmptyString(p.peerIdSafe)) return null;
    return { type: 'stream_stopped', peerIdSafe: p.peerIdSafe };
  },
  peer_profile_updated: (p) => {
    if (!isNonEmptyString(p.peerIdSafe)) return null;
    if (!isNonEmptyString(p.displayName)) return null;
    if (!isString(p.avatarUrl)) return null;
    return {
      type: 'peer_profile_updated',
      peerIdSafe: p.peerIdSafe,
      displayName: p.displayName,
      avatarUrl: p.avatarUrl,
    };
  },
  renegotiate_offer: (p) => {
    if (!isNonEmptyString(p.fromPeerIdSafe)) return null;
    const sdp = parseSdpInit(p.sdp);
    if (!sdp) return null;
    return { type: 'renegotiate_offer', fromPeerIdSafe: p.fromPeerIdSafe, sdp };
  },
  renegotiate_answer: (p) => {
    if (!isNonEmptyString(p.fromPeerIdSafe)) return null;
    const sdp = parseSdpInit(p.sdp);
    if (!sdp) return null;
    return { type: 'renegotiate_answer', fromPeerIdSafe: p.fromPeerIdSafe, sdp };
  },
  renegotiate_ice: (p) => {
    if (!isNonEmptyString(p.fromPeerIdSafe)) return null;
    const candidate = parseIceCandidateInit(p.candidate);
    if (!candidate) return null;
    return { type: 'renegotiate_ice', fromPeerIdSafe: p.fromPeerIdSafe, candidate };
  },
  peer_left: (p) => {
    if (!isNonEmptyString(p.peerIdSafe)) return null;
    return { type: 'peer_left', peerIdSafe: p.peerIdSafe };
  },
  peer_kicked: parsePeerKickedPayload,
  ping: (p) => {
    if (!isFiniteNumber(p.sentAt)) return null;
    return { type: 'ping', sentAt: p.sentAt };
  },
  pong: (p) => {
    if (!isFiniteNumber(p.echoSentAt) || !isFiniteNumber(p.respondedAt)) return null;
    return { type: 'pong', echoSentAt: p.echoSentAt, respondedAt: p.respondedAt };
  },
};

/** Validates and parses a raw RTCDataChannel envelope. */
export const parseDataChannelMessage = (raw: unknown): DataChannelEnvelopeDto | null => {
  const data = parseJsonInput(raw);
  if (!isRecord(data)) return null;
  if (data.version !== 1) return null;
  if (!isNonEmptyString(data.sessionToken)) return null;
  if (!isNonEmptyString(data.senderPeerIdSafe)) return null;
  if (!isFiniteNumber(data.sentAt)) return null;
  if (!isRecord(data.payload) || !isNonEmptyString(data.payload.type)) return null;

  const parser = DATA_CHANNEL_PAYLOAD_PARSERS[data.payload.type as DataChannelMessageType];
  if (!parser) return null;

  const payload = parser(data.payload);
  if (!payload) return null;

  return {
    version: 1,
    sessionToken: data.sessionToken,
    senderPeerIdSafe: data.senderPeerIdSafe,
    sentAt: data.sentAt,
    payload,
  };
};

const parseUserProfile = (value: unknown): UserProfile | null => {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.nickname)) return null;
  if (!isNonEmptyString(value.peerTag)) return null;
  if (!isString(value.avatarUrl)) return null;
  if (!isString(value.avatarName)) return null;

  return {
    nickname: value.nickname,
    peerTag: value.peerTag,
    avatarUrl: value.avatarUrl,
    avatarName: value.avatarName,
    telemetryConsent: isTelemetryConsentState(value.telemetryConsent) ? value.telemetryConsent : undefined,
    preferredFps: isStreamFps(value.preferredFps) ? value.preferredFps : undefined,
    machineHash: isString(value.machineHash) ? value.machineHash : undefined,
  };
};

const parseActiveMinimizedHub = (value: unknown): ActiveMinimizedHubDto | null => {
  if (!isRecord(value)) return null;
  if (!isNonEmptyString(value.hubId)) return null;
  if (!isRoomRole(value.role)) return null;
  if (!isFiniteNumber(value.activeStreamsCount)) return null;
  if (!isBoolean(value.isSharing)) return null;
  if (!isFiniteNumber(value.minimizedAt)) return null;

  return {
    hubId: value.hubId,
    role: value.role,
    activeStreamsCount: value.activeStreamsCount,
    isSharing: value.isSharing,
    minimizedAt: value.minimizedAt,
  };
};

type LocalBusParser = (p: Record<string, unknown>) => LocalWindowBusMessage | null;

const LOCAL_BUS_PARSERS: Record<LocalWindowBusMessageType, LocalBusParser> = {
  profile_updated: (p) => {
    const profile = parseUserProfile(p.profile);
    if (!profile) return null;
    return { type: 'profile_updated', profile };
  },
  minimized_hub_updated: (p) => {
    const hub = parseActiveMinimizedHub(p.hub);
    if (!hub) return null;
    return { type: 'minimized_hub_updated', hub };
  },
  minimized_hub_cleared: (p) => {
    if (!isNonEmptyString(p.hubId)) return null;
    return { type: 'minimized_hub_cleared', hubId: p.hubId };
  },
  restore_hub_requested: (p) => {
    if (!isNonEmptyString(p.hubId)) return null;
    return { type: 'restore_hub_requested', hubId: p.hubId };
  },
  disconnect_hub_requested: (p) => {
    if (!isNonEmptyString(p.hubId)) return null;
    return { type: 'disconnect_hub_requested', hubId: p.hubId };
  },
  owner_room_status: (p) => {
    if (!isNonEmptyString(p.hubId) || typeof p.active !== 'boolean') return null;
    return { type: 'owner_room_status', hubId: p.hubId, active: p.active };
  },
};

/** Validates and parses a cross-window local bus message. */
export const parseLocalBusMessage = (raw: unknown): LocalWindowBusMessage | null => {
  const data = parseJsonInput(raw);
  if (!isRecord(data) || !isNonEmptyString(data.type)) return null;

  const parser = LOCAL_BUS_PARSERS[data.type as LocalWindowBusMessageType];
  if (!parser) return null;

  return parser(data);
};

/** Sanitizes a user-entered hub code or topic into a safe canonical hub topic. */
export const sanitizeHubCode = (rawInput: string): string => {
  if (!isNonEmptyString(rawInput)) return '';

  const stripped = rawInput
    .trim()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[+*?&\s]/g, '')
    .replace(/\/{2,}/g, '/');

  if (!stripped) return '';

  const normalized = normalizeHubTopic(stripped);
  if (!normalized || normalized === 'elfy/hub' || normalized === 'elfy/hub/') {
    return '';
  }

  return normalized;
};

/** Checks whether the room can admit another peer under ROOM_CONFIG concurrency caps. */
export const canAcceptMorePeers = (currentCount: number): boolean => {
  if (!ROOM_CONFIG.ENFORCE_MAX_PEERS) return true;
  if (!Number.isFinite(currentCount) || currentCount < 0) return false;
  return currentCount < ROOM_CONFIG.MAX_CONCURRENT_PEERS;
};
