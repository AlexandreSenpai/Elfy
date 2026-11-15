import { MutableRefObject } from 'react';
import { DEFAULT_USER_PROFILE } from '../../data/mockData';
import {
  DataChannelEnvelopeDto,
  LocalWindowBusMessage,
  RoomPeerDto,
  RoomRole,
  SignalingEnvelopeDto,
  SignalingPayload,
  StreamFpsOption,
  StreamResolutionPreset,
  SystemMetricsDto,
  UserProfile,
} from '../../domain/dtos';
import { formatFullPeerTag } from '../../utils/hubTopics';

export const KNOCK_TIMEOUT_MS = 30_000;
export const METRICS_POLL_MS = 2_000;
export const KEEPALIVE_POLL_MS = 2_000;

export const EMPTY_METRICS: SystemMetricsDto = {
  cpuUsagePercent: 0,
  memoryUsedMb: 0,
  memoryTotalMb: 0,
  highLoadWarning: false,
  cpuCores: 0,
  outboundFps: 0,
  inboundFps: 0,
  droppedFrames: 0,
  rttMs: 0,
  activeCodec: '',
  isHardwareAccelerated: null,
  encoderImplementation: '',
  qualityLimitationReason: 'none',
  outboundBitrateKbps: 0,
  inboundBitrateKbps: 0,
  packetLossPercent: 0,
  jitterMs: 0,
  audioCodec: '',
  audioBitrateKbps: 0,
  audioJitterBufferMs: 0,
  audioPacketsLost: 0,
  peerStats: {},
};

export const getNextFpsOption = (current: StreamFpsOption): StreamFpsOption => {
  if (current === 60) return 30;
  if (current === 30) return 120;
  return 60;
};

export const getNextResolutionPreset = (
  current: StreamResolutionPreset
): StreamResolutionPreset => {
  if (current === '1080p') return '720p';
  if (current === '720p') return 'source';
  return '1080p';
};

export const formatResolutionLabel = (resolution: StreamResolutionPreset | string): string => {
  if (resolution === 'source') return 'Native';
  return resolution;
};

export interface RemoteStreamMeta {
  resolution: string;
  fps: StreamFpsOption;
  displayName?: string;
  avatarUrl?: string;
}

export interface RoomIdentityRefs {
  mountedRef: MutableRefObject<boolean>;
  profileRef: MutableRefObject<UserProfile>;
  roleRef: MutableRefObject<RoomRole>;
  hubRef: MutableRefObject<string>;
  localPeerIdRef: MutableRefObject<string>;
  hostInfoRef: MutableRefObject<{ displayName: string; tag: string }>;
}

export type SignalingHandler = (envelope: SignalingEnvelopeDto) => Promise<void> | void;
export type DataChannelHandler = (peerIdSafe: string, envelope: DataChannelEnvelopeDto) => void;
export type BusHandler = (message: LocalWindowBusMessage) => void;

export const createUniqueId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

export const toPeerCountTier = (count: number): string => {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  return '4+';
};

export const toCpuTier = (cpu: number): string => {
  if (cpu >= 80) return 'high';
  if (cpu >= 50) return 'medium';
  return 'low';
};

export const toRamTier = (usedMb: number, totalMb: number): string => {
  if (totalMb <= 0) return 'unknown';
  const ratio = usedMb / totalMb;
  if (ratio >= 0.85) return 'high';
  if (ratio >= 0.6) return 'medium';
  return 'low';
};

export const toRttBucket = (rttMs: number): string => {
  if (rttMs <= 0) return 'unknown';
  if (rttMs < 25) return '0-25ms';
  if (rttMs < 60) return '25-60ms';
  return '60ms+';
};

export const isWaitingForDefaultProfile = (
  profile: UserProfile,
  isProfileLoading?: boolean
): boolean => {
  if (isProfileLoading !== undefined) {
    return isProfileLoading;
  }
  if (profile.machineHash) return false;
  return (
    profile.peerTag === DEFAULT_USER_PROFILE.peerTag &&
    profile.nickname === DEFAULT_USER_PROFILE.nickname
  );
};

export const createSignalingEnvelope = <T extends SignalingPayload>(
  hubId: string,
  senderPeerIdSafe: string,
  payload: T
): SignalingEnvelopeDto<T> => ({
  version: 1,
  messageId: createUniqueId('msg'),
  hubId,
  senderPeerIdSafe,
  sentAt: Date.now(),
  payload,
});

export const createSelfPeer = (
  profile: UserProfile,
  peerIdSafe: string,
  role: RoomRole,
  isStreaming: boolean
): RoomPeerDto => ({
  peerIdSafe,
  peerTag: formatFullPeerTag(profile.nickname, profile.peerTag),
  displayName: profile.nickname,
  avatarUrl: profile.avatarUrl,
  role,
  isStreaming,
  joinedAt: Date.now(),
});

export const getMeshTokenForPair = (hubId: string, peerA: string, peerB: string): string => {
  const ordered = [peerA, peerB].sort().join('__');
  return `mesh_${hubId}_${ordered}`;
};
