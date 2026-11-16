import { EMPTY_AUDIO_TELEMETRY } from '../../domain/config';
import { AudioTelemetryDto } from '../../domain/dtos';
import type { JitterBufferSample } from './peerTypes';

export interface VideoTrackMeta {
  width: number;
  height: number;
  frameRate: number;
}

export interface AudioTrackMeta {
  liveTrackCount: number;
  sampleRateHz: number;
  channels: number;
}

export interface ReceivingAudioTrackState {
  hasAudioTransceivers: boolean;
  hasAnyActiveReceiver: boolean;
  activeTrackIds: Set<string>;
  inactiveTrackIds: Set<string>;
}

const INACTIVE_RECV_DIRECTIONS = new Set<string>(['inactive', 'stopped', 'sendonly']);

/**
 * Inspects RTCPeerConnection audio transceivers to distinguish actively
 * receiving audio tracks from stale muted tracks kept after prior shares.
 */
export const getReceivingAudioTrackState = (
  pc?: RTCPeerConnection
): ReceivingAudioTrackState => {
  const activeTrackIds = new Set<string>();
  const inactiveTrackIds = new Set<string>();
  if (!pc || typeof pc.getTransceivers !== 'function') {
    return {
      hasAudioTransceivers: false,
      hasAnyActiveReceiver: false,
      activeTrackIds,
      inactiveTrackIds,
    };
  }

  let hasAudioTransceivers = false;
  for (const transceiver of pc.getTransceivers()) {
    const track = transceiver.receiver?.track;
    const isAudioTransceiver =
      track?.kind === 'audio' || transceiver.sender?.track?.kind === 'audio';
    if (!isAudioTransceiver) continue;
    hasAudioTransceivers = true;

    if (!track || track.kind !== 'audio') continue;
    const dir = transceiver.currentDirection ?? '';
    if (INACTIVE_RECV_DIRECTIONS.has(dir) || track.readyState !== 'live') {
      inactiveTrackIds.add(track.id);
      continue;
    }

    const dirCanReceive =
      dir === 'recvonly' || dir === 'sendrecv' || (dir === '' && !track.muted);
    if (dirCanReceive && !track.muted) {
      activeTrackIds.add(track.id);
    }
  }

  return {
    hasAudioTransceivers,
    hasAnyActiveReceiver: activeTrackIds.size > 0,
    activeTrackIds,
    inactiveTrackIds,
  };
};

export interface AudioDirectionAccumulator {
  hasActiveRtp: boolean;
  codec: string;
  sampleRateHz: number;
  channels: number;
  bitrateKbps: number;
  jitterBufferMsTotal: number;
  jitterBufferSamples: number;
  jitterMsTotal: number;
  jitterSamples: number;
  packetsLost: number;
  lossSamples: number[];
  audioLevel: number | null;
}

export const createAudioDirectionAccumulator = (): AudioDirectionAccumulator => ({
  hasActiveRtp: false,
  codec: '',
  sampleRateHz: 0,
  channels: 0,
  bitrateKbps: 0,
  jitterBufferMsTotal: 0,
  jitterBufferSamples: 0,
  jitterMsTotal: 0,
  jitterSamples: 0,
  packetsLost: 0,
  lossSamples: [],
  audioLevel: null,
});

export const roundStat = (value: number, decimals: number): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

export const averageStat = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
};

export const normalizeCodecLabel = (mimeType: unknown): string => {
  if (typeof mimeType !== 'string' || !mimeType.trim()) return '';
  return mimeType.replace(/^(?:video|audio)\//i, '').trim().toUpperCase();
};

export const readVideoTrackMetadata = (stream: MediaStream | null): VideoTrackMeta => {
  if (!stream) return { width: 0, height: 0, frameRate: 0 };
  const liveTrack = stream.getVideoTracks().find((track) => track.readyState === 'live');
  if (!liveTrack) return { width: 0, height: 0, frameRate: 0 };

  const settings = liveTrack.getSettings();
  const width =
    typeof settings.width === 'number' && Number.isFinite(settings.width) && settings.width > 0
      ? Math.round(settings.width)
      : 0;
  const height =
    typeof settings.height === 'number' && Number.isFinite(settings.height) && settings.height > 0
      ? Math.round(settings.height)
      : 0;
  const frameRate =
    typeof settings.frameRate === 'number' &&
    Number.isFinite(settings.frameRate) &&
    settings.frameRate > 0
      ? Math.round(settings.frameRate)
      : 0;

  return { width, height, frameRate };
};

export const readAudioTrackMetadata = (
  stream: MediaStream | null,
  pc?: RTCPeerConnection
): AudioTrackMeta => {
  if (!stream) return { liveTrackCount: 0, sampleRateHz: 0, channels: 0 };
  const recvState = getReceivingAudioTrackState(pc);
  const liveTracks = stream.getAudioTracks().filter((track) => {
    if (track.readyState !== 'live') return false;
    if (recvState.inactiveTrackIds.has(track.id)) return false;
    if (recvState.hasAudioTransceivers && track.muted) return false;
    return true;
  });
  if (liveTracks.length === 0) return { liveTrackCount: 0, sampleRateHz: 0, channels: 0 };

  const settings = liveTracks[0].getSettings();
  const sampleRateHz =
    typeof settings.sampleRate === 'number' &&
    Number.isFinite(settings.sampleRate) &&
    settings.sampleRate > 0
      ? Math.round(settings.sampleRate)
      : 0;
  const channels =
    typeof settings.channelCount === 'number' &&
    Number.isFinite(settings.channelCount) &&
    settings.channelCount > 0
      ? Math.round(settings.channelCount)
      : 0;

  return { liveTrackCount: liveTracks.length, sampleRateHz, channels };
};

export const resolveAudioCodecDetails = (
  report: RTCStatsReport,
  codecId: unknown
): { codec: string; sampleRateHz: number; channels: number } => {
  if (typeof codecId !== 'string' || !codecId) {
    return { codec: '', sampleRateHz: 0, channels: 0 };
  }
  const codecStat = report.get(codecId) as
    | { mimeType?: unknown; clockRate?: unknown; channels?: unknown; sdpFmtpLine?: unknown }
    | undefined;

  const codec = normalizeCodecLabel(codecStat?.mimeType);
  const sampleRateHz =
    typeof codecStat?.clockRate === 'number' &&
    Number.isFinite(codecStat.clockRate) &&
    codecStat.clockRate > 0
      ? Math.round(codecStat.clockRate)
      : 0;

  let channels =
    typeof codecStat?.channels === 'number' &&
    Number.isFinite(codecStat.channels) &&
    codecStat.channels > 0
      ? Math.round(codecStat.channels)
      : 0;
  if (
    channels === 0 &&
    typeof codecStat?.sdpFmtpLine === 'string' &&
    /(?:^|;)\s*stereo=1\b/i.test(codecStat.sdpFmtpLine)
  ) {
    channels = 2;
  }

  return { codec, sampleRateHz, channels };
};

/** Computes recent-window jitter buffer latency in ms using delta delay/emitted counts. */
export const updateJitterBufferDeltaMs = (
  peerIdSafe: string,
  stat: Record<string, unknown>,
  tracker: Map<string, JitterBufferSample>
): number | null => {
  const delay = Number(stat.jitterBufferDelay ?? 0);
  const emitted = Number(stat.jitterBufferEmittedCount ?? 0);
  if (!Number.isFinite(delay) || !Number.isFinite(emitted) || delay < 0 || emitted <= 0) {
    return null;
  }

  const statId = typeof stat.id === 'string' && stat.id ? stat.id : 'in-audio';
  const key = `${peerIdSafe}:jb:${statId}`;
  const prev = tracker.get(key);
  tracker.set(key, { delay, emitted });

  if (prev && delay >= prev.delay && emitted > prev.emitted) {
    return ((delay - prev.delay) / (emitted - prev.emitted)) * 1000;
  }
  if (!prev) {
    return (delay / emitted) * 1000;
  }
  return null;
};

export const finalizeAudioTelemetry = (
  acc: AudioDirectionAccumulator,
  trackMeta: AudioTrackMeta
): AudioTelemetryDto => {
  const hasAudio = trackMeta.liveTrackCount > 0 || acc.hasActiveRtp;
  if (!hasAudio) {
    return { ...EMPTY_AUDIO_TELEMETRY };
  }

  const sampleRateHz = trackMeta.sampleRateHz > 0 ? trackMeta.sampleRateHz : acc.sampleRateHz;
  const channels = trackMeta.channels > 0 ? trackMeta.channels : acc.channels;

  return {
    hasAudio: true,
    trackCount: trackMeta.liveTrackCount > 0 ? trackMeta.liveTrackCount : acc.hasActiveRtp ? 1 : 0,
    codec: acc.codec,
    sampleRateHz,
    channels,
    bitrateKbps: Math.max(0, Math.round(acc.bitrateKbps)),
    jitterBufferMs:
      acc.jitterBufferSamples > 0
        ? roundStat(acc.jitterBufferMsTotal / acc.jitterBufferSamples, 1)
        : 0,
    jitterMs: acc.jitterSamples > 0 ? roundStat(acc.jitterMsTotal / acc.jitterSamples, 1) : 0,
    packetsLost: Math.max(0, acc.packetsLost),
    packetLossPercent: acc.lossSamples.length > 0 ? roundStat(averageStat(acc.lossSamples), 2) : 0,
    audioLevel: acc.audioLevel,
  };
};
