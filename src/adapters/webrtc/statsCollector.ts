import { PeerTelemetryDto, StreamQualityLimitationReason } from '../../domain/dtos';
import { WebRtcStatsSnapshot } from '../../ports';
import {
  BitrateSample,
  PacketLossSample,
  PeerEntry,
  StatsAccumulator,
  StatsSampleTracker,
  createStatsSampleTracker,
} from './peerTypes';

const HW_ENCODER_PATTERN =
  /mediafoundation|nvenc|qsv|quicksync|amf|vce|vaapi|videotoolbox|mediacodec|externalencoder/i;
const SW_ENCODER_PATTERN = /libvpx|openh264|libaom|ffmpeg|software/i;

const LIMITATION_PRIORITY: Record<StreamQualityLimitationReason, number> = {
  none: 0,
  other: 1,
  bandwidth: 2,
  cpu: 3,
};

interface CandidatePairRtt {
  id: string;
  nominated: boolean;
  rttMs: number;
}

interface PeerStatsAccumulator {
  outboundBitrateKbps: number;
  inboundBitrateKbps: number;
  outboundFps: number;
  inboundFps: number;
  selectedPairId: string;
  candidatePairs: CandidatePairRtt[];
  remoteInboundRttMs: number[];
  videoLossSamples: number[];
  audioLossSamples: number[];
  jitterMsSamples: number[];
}

interface StatContext {
  peerIdSafe: string;
  report: RTCStatsReport;
  tracker: StatsSampleTracker;
  acc: StatsAccumulator;
  peerAcc: PeerStatsAccumulator;
}

const createPeerAccumulator = (): PeerStatsAccumulator => ({
  outboundBitrateKbps: 0,
  inboundBitrateKbps: 0,
  outboundFps: 0,
  inboundFps: 0,
  selectedPairId: '',
  candidatePairs: [],
  remoteInboundRttMs: [],
  videoLossSamples: [],
  audioLossSamples: [],
  jitterMsSamples: [],
});

const roundTo = (value: number, decimals: number): number => {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const average = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, val) => sum + val, 0) / values.length;
};

const normalizeCodecLabel = (mimeType: unknown): string => {
  if (typeof mimeType !== 'string' || !mimeType.trim()) return '';
  return mimeType.replace(/^(?:video|audio)\//i, '').trim().toUpperCase();
};

const normalizeQualityLimitation = (value: unknown): StreamQualityLimitationReason => {
  if (value === 'cpu' || value === 'bandwidth' || value === 'other' || value === 'none') {
    return value;
  }
  return 'none';
};

/** Infers whether the active outbound encoder runs on GPU hardware vs CPU software. */
export const inferHardwareEncoder = (
  powerEfficientEncoder: unknown,
  encoderImplementation: string
): boolean | null => {
  if (typeof powerEfficientEncoder === 'boolean') return powerEfficientEncoder;
  if (!encoderImplementation) return null;
  if (HW_ENCODER_PATTERN.test(encoderImplementation)) return true;
  if (SW_ENCODER_PATTERN.test(encoderImplementation)) return false;
  return null;
};

const resolveReportCodecName = (report: RTCStatsReport, codecId: unknown): string => {
  if (typeof codecId !== 'string' || !codecId) return '';
  const codecStat = report.get(codecId) as { mimeType?: unknown } | undefined;
  return normalizeCodecLabel(codecStat?.mimeType);
};

const updateBitrateFromSample = (
  peerIdSafe: string,
  stat: Record<string, unknown>,
  direction: 'out' | 'in',
  tracker: Map<string, BitrateSample>
): number => {
  const bytes = Number((direction === 'out' ? stat.bytesSent : stat.bytesReceived) ?? 0);
  const timestamp = Number(stat.timestamp ?? 0);
  if (!Number.isFinite(bytes) || bytes < 0 || !Number.isFinite(timestamp) || timestamp <= 0) {
    return 0;
  }

  const statId = typeof stat.id === 'string' && stat.id ? stat.id : direction;
  const key = `${peerIdSafe}:${direction}:${statId}`;
  const prev = tracker.get(key);
  tracker.set(key, { bytes, timestamp });
  if (!prev || timestamp <= prev.timestamp || bytes < prev.bytes) return 0;

  const elapsedSec = (timestamp - prev.timestamp) / 1000;
  return elapsedSec > 0 ? Math.round(((bytes - prev.bytes) * 8) / elapsedSec / 1000) : 0;
};

const updatePacketLossFromSample = (
  peerIdSafe: string,
  statId: string,
  packetsLostRaw: number,
  packetsTotalRaw: number,
  tracker: Map<string, PacketLossSample>
): number | null => {
  if (!Number.isFinite(packetsLostRaw) || !Number.isFinite(packetsTotalRaw)) return null;

  const packetsLost = Math.max(0, packetsLostRaw);
  const packetsTotal = Math.max(0, packetsTotalRaw);
  const key = `${peerIdSafe}:loss:${statId}`;
  const prev = tracker.get(key);
  tracker.set(key, { packetsLost, packetsTotal });

  if (prev && packetsLost >= prev.packetsLost && packetsTotal >= prev.packetsTotal) {
    const deltaTotal = packetsTotal - prev.packetsTotal;
    if (deltaTotal <= 0) return 0;
    return Math.min(100, Math.max(0, ((packetsLost - prev.packetsLost) / deltaTotal) * 100));
  }

  if (packetsTotal <= 0) return null;
  return Math.min(100, Math.max(0, (packetsLost / packetsTotal) * 100));
};

const recordJitterSample = (
  stat: Record<string, unknown>,
  isActive: boolean,
  peerAcc: PeerStatsAccumulator
): void => {
  if (typeof stat.jitter !== 'number' || !Number.isFinite(stat.jitter) || stat.jitter < 0) return;
  if (!isActive && stat.jitter === 0) return;
  peerAcc.jitterMsSamples.push(stat.jitter * 1000);
};

const accumulateOutboundVideoStat = (stat: Record<string, unknown>, ctx: StatContext): void => {
  const { peerIdSafe, report, tracker, acc, peerAcc } = ctx;
  const fps = Number(stat.framesPerSecond ?? 0);
  if (fps > acc.outboundFps) acc.outboundFps = fps;
  if (fps > peerAcc.outboundFps) peerAcc.outboundFps = fps;

  const isActive = fps > 0 || Number(stat.bytesSent ?? 0) > 0 || Number(stat.framesSent ?? 0) > 0;
  if (!isActive) return;

  const kbps = updateBitrateFromSample(peerIdSafe, stat, 'out', tracker.bitrate);
  acc.outboundBitrateKbps += kbps;
  peerAcc.outboundBitrateKbps += kbps;

  if (!acc.activeCodec) acc.activeCodec = resolveReportCodecName(report, stat.codecId);

  const impl = typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation.trim() : '';
  if (impl && !acc.encoderImplementation) acc.encoderImplementation = impl;

  const hwDetected = inferHardwareEncoder(stat.powerEfficientEncoder, impl);
  if (hwDetected !== null) {
    acc.isHardwareAccelerated = acc.isHardwareAccelerated === false ? false : hwDetected;
  }

  const limitation = normalizeQualityLimitation(stat.qualityLimitationReason);
  if (LIMITATION_PRIORITY[limitation] > LIMITATION_PRIORITY[acc.qualityLimitationReason]) {
    acc.qualityLimitationReason = limitation;
  }
};

const accumulateInboundMediaLoss = (
  stat: Record<string, unknown>,
  fallbackId: string,
  ctx: StatContext,
  target: number[]
): void => {
  const received = Math.max(0, Number(stat.packetsReceived ?? 0));
  const lost = Math.max(0, Number(stat.packetsLost ?? 0));
  const statId = typeof stat.id === 'string' && stat.id ? stat.id : fallbackId;
  const pct = updatePacketLossFromSample(
    ctx.peerIdSafe,
    statId,
    lost,
    received + lost,
    ctx.tracker.packetLoss
  );
  if (pct !== null) target.push(pct);
};

const accumulateInboundVideoStat = (stat: Record<string, unknown>, ctx: StatContext): void => {
  const { peerIdSafe, report, tracker, acc, peerAcc } = ctx;
  const fps = Number(stat.framesPerSecond ?? 0);
  if (fps > acc.inboundFps) acc.inboundFps = fps;
  if (fps > peerAcc.inboundFps) peerAcc.inboundFps = fps;
  acc.droppedFrames += Math.max(0, Number(stat.framesDropped ?? 0));

  const isActive =
    fps > 0 ||
    Number(stat.bytesReceived ?? 0) > 0 ||
    Number(stat.framesDecoded ?? 0) > 0 ||
    Number(stat.packetsReceived ?? 0) > 0;

  if (isActive) {
    const kbps = updateBitrateFromSample(peerIdSafe, stat, 'in', tracker.bitrate);
    acc.inboundBitrateKbps += kbps;
    peerAcc.inboundBitrateKbps += kbps;
    if (!acc.activeCodec) acc.activeCodec = resolveReportCodecName(report, stat.codecId);
  }

  recordJitterSample(stat, isActive, peerAcc);
  accumulateInboundMediaLoss(stat, 'in-video', ctx, peerAcc.videoLossSamples);
};

const accumulateAudioStat = (
  stat: Record<string, unknown>,
  direction: 'out' | 'in',
  ctx: StatContext
): void => {
  const { peerIdSafe, report, tracker, acc, peerAcc } = ctx;
  const bytes = Number((direction === 'out' ? stat.bytesSent : stat.bytesReceived) ?? 0);
  const packets = Number((direction === 'out' ? stat.packetsSent : stat.packetsReceived) ?? 0);
  const isActive = bytes > 0 || packets > 0;

  if (isActive) {
    acc.audioBitrateKbps += updateBitrateFromSample(peerIdSafe, stat, direction, tracker.bitrate);
    if (!acc.audioCodec) acc.audioCodec = resolveReportCodecName(report, stat.codecId);
  }

  if (direction === 'out') return;

  acc.audioPacketsLost += Math.max(0, Number(stat.packetsLost ?? 0));
  recordJitterSample(stat, isActive, peerAcc);

  const jbDelay = Number(stat.jitterBufferDelay ?? 0);
  const jbEmitted = Number(stat.jitterBufferEmittedCount ?? 0);
  if (Number.isFinite(jbDelay) && Number.isFinite(jbEmitted) && jbEmitted > 0 && jbDelay >= 0) {
    acc.audioJitterBufferMsTotal += (jbDelay / jbEmitted) * 1000;
    acc.audioJitterBufferSamples += 1;
  }

  accumulateInboundMediaLoss(stat, 'in-audio', ctx, peerAcc.audioLossSamples);
};

const resolveRemoteInboundLoss = (stat: Record<string, unknown>, ctx: StatContext): number | null => {
  if (typeof stat.fractionLost === 'number' && Number.isFinite(stat.fractionLost)) {
    return Math.min(100, Math.max(0, stat.fractionLost * 100));
  }

  const statId = typeof stat.id === 'string' && stat.id ? stat.id : `remote-${String(stat.kind ?? 'media')}`;
  const lost = Math.max(0, Number(stat.packetsLost ?? 0));
  const received = typeof stat.packetsReceived === 'number' && Number.isFinite(stat.packetsReceived)
    ? Math.max(0, stat.packetsReceived)
    : null;

  if (received !== null) {
    return updatePacketLossFromSample(ctx.peerIdSafe, statId, lost, received + lost, ctx.tracker.packetLoss);
  }

  if (typeof stat.localId === 'string' && stat.localId) {
    const outbound = ctx.report.get(stat.localId) as Record<string, unknown> | undefined;
    const sent = Number(outbound?.packetsSent ?? 0);
    if (Number.isFinite(sent) && sent > 0) {
      return updatePacketLossFromSample(
        ctx.peerIdSafe,
        statId,
        lost,
        Math.max(sent, lost),
        ctx.tracker.packetLoss
      );
    }
  }

  return null;
};

const accumulateRemoteInboundStat = (stat: Record<string, unknown>, ctx: StatContext): void => {
  if (stat.kind !== 'video' && stat.kind !== 'audio') return;
  if (stat.kind === 'audio') {
    ctx.acc.audioPacketsLost += Math.max(0, Number(stat.packetsLost ?? 0));
  }

  const rttSec = Number(stat.roundTripTime ?? 0);
  if (Number.isFinite(rttSec) && rttSec > 0) {
    ctx.peerAcc.remoteInboundRttMs.push(rttSec * 1000);
  }

  recordJitterSample(stat, true, ctx.peerAcc);
  const lossPct = resolveRemoteInboundLoss(stat, ctx);
  if (lossPct === null) return;

  if (stat.kind === 'video') {
    ctx.peerAcc.videoLossSamples.push(lossPct);
  } else {
    ctx.peerAcc.audioLossSamples.push(lossPct);
  }
};

const accumulateStatReport = (stat: Record<string, unknown>, ctx: StatContext): void => {
  if (stat.type === 'outbound-rtp' && stat.kind === 'video') {
    accumulateOutboundVideoStat(stat, ctx);
  } else if (stat.type === 'inbound-rtp' && stat.kind === 'video') {
    accumulateInboundVideoStat(stat, ctx);
  } else if (stat.type === 'outbound-rtp' && stat.kind === 'audio') {
    accumulateAudioStat(stat, 'out', ctx);
  } else if (stat.type === 'inbound-rtp' && stat.kind === 'audio') {
    accumulateAudioStat(stat, 'in', ctx);
  } else if (stat.type === 'remote-inbound-rtp') {
    accumulateRemoteInboundStat(stat, ctx);
  } else if (stat.type === 'transport' && typeof stat.selectedCandidatePairId === 'string') {
    ctx.peerAcc.selectedPairId = stat.selectedCandidatePairId;
  } else if (stat.type === 'candidate-pair' && stat.state === 'succeeded') {
    const rttSec = Number(stat.currentRoundTripTime ?? 0);
    if (Number.isFinite(rttSec) && rttSec > 0) {
      ctx.peerAcc.candidatePairs.push({
        id: typeof stat.id === 'string' ? stat.id : '',
        nominated: stat.nominated === true,
        rttMs: rttSec * 1000,
      });
    }
  }
};

const resolvePeerRttMs = (peerAcc: PeerStatsAccumulator): number => {
  if (peerAcc.selectedPairId) {
    const selected = peerAcc.candidatePairs.find((pair) => pair.id === peerAcc.selectedPairId);
    if (selected) return selected.rttMs;
  }
  const nominated = peerAcc.candidatePairs.find((pair) => pair.nominated);
  if (nominated) return nominated.rttMs;
  if (peerAcc.candidatePairs.length > 0) return average(peerAcc.candidatePairs.map((p) => p.rttMs));
  if (peerAcc.remoteInboundRttMs.length > 0) return average(peerAcc.remoteInboundRttMs);
  return 0;
};

const finalizePeerTelemetry = (
  entry: PeerEntry,
  peerAcc: PeerStatsAccumulator,
  acc: StatsAccumulator
): PeerTelemetryDto => {
  const rawRttMs = resolvePeerRttMs(peerAcc);
  if (rawRttMs > 0) {
    acc.rttMs += rawRttMs;
    acc.rttSamples += 1;
  }

  const lossSource =
    peerAcc.videoLossSamples.length > 0 ? peerAcc.videoLossSamples : peerAcc.audioLossSamples;
  const packetLossPercent = roundTo(average(lossSource), 2);
  if (lossSource.length > 0) {
    acc.packetLossPercentTotal += packetLossPercent;
    acc.packetLossSamples += 1;
  }

  const jitterMs = roundTo(average(peerAcc.jitterMsSamples), 1);
  if (peerAcc.jitterMsSamples.length > 0) {
    acc.jitterMsTotal += jitterMs;
    acc.jitterSamples += 1;
  }

  return {
    peerIdSafe: entry.peerIdSafe,
    rttMs: Math.round(rawRttMs),
    bitrateKbps: peerAcc.outboundBitrateKbps + peerAcc.inboundBitrateKbps,
    fps: Math.round(peerAcc.inboundFps > 0 ? peerAcc.inboundFps : peerAcc.outboundFps),
    packetLossPercent,
    jitterMs,
    connectionState: entry.pc.connectionState ?? 'unknown',
    dataChannelState: entry.dataChannel?.readyState ?? 'closed',
  };
};

const collectPeerStats = async (
  entry: PeerEntry,
  tracker: StatsSampleTracker,
  acc: StatsAccumulator
): Promise<void> => {
  if (entry.pc.connectionState === 'closed') return;
  const peerAcc = createPeerAccumulator();

  try {
    const report = await entry.pc.getStats();
    const ctx: StatContext = { peerIdSafe: entry.peerIdSafe, report, tracker, acc, peerAcc };
    report.forEach((statEntry) => {
      accumulateStatReport(statEntry as unknown as Record<string, unknown>, ctx);
    });
  } catch {
    // Peer may close concurrently while stats are polled.
  }

  acc.peerStats[entry.peerIdSafe] = finalizePeerTelemetry(entry, peerAcc, acc);
};

/**
 * Aggregates outbound/inbound video FPS, dropped frames, RTT, active codecs,
 * hardware acceleration telemetry, bitrates, packet loss, jitter, audio health,
 * and per-peer telemetry across all active WebRTC peers.
 */
export const collectWebRtcStats = async (
  peers: Iterable<PeerEntry>,
  tracker: StatsSampleTracker = createStatsSampleTracker()
): Promise<WebRtcStatsSnapshot> => {
  const acc: StatsAccumulator = {
    outboundFps: 0,
    inboundFps: 0,
    droppedFrames: 0,
    rttMs: 0,
    rttSamples: 0,
    activeCodec: '',
    isHardwareAccelerated: null,
    encoderImplementation: '',
    qualityLimitationReason: 'none',
    outboundBitrateKbps: 0,
    inboundBitrateKbps: 0,
    packetLossPercentTotal: 0,
    packetLossSamples: 0,
    jitterMsTotal: 0,
    jitterSamples: 0,
    audioCodec: '',
    audioBitrateKbps: 0,
    audioJitterBufferMsTotal: 0,
    audioJitterBufferSamples: 0,
    audioPacketsLost: 0,
    peerStats: {},
  };

  for (const entry of peers) {
    await collectPeerStats(entry, tracker, acc);
  }

  return {
    outboundFps: acc.outboundFps,
    inboundFps: acc.inboundFps,
    droppedFrames: acc.droppedFrames,
    rttMs: acc.rttSamples > 0 ? acc.rttMs / acc.rttSamples : 0,
    activeCodec: acc.activeCodec,
    isHardwareAccelerated: acc.isHardwareAccelerated,
    encoderImplementation: acc.encoderImplementation,
    qualityLimitationReason: acc.qualityLimitationReason,
    outboundBitrateKbps: acc.outboundBitrateKbps,
    inboundBitrateKbps: acc.inboundBitrateKbps,
    packetLossPercent:
      acc.packetLossSamples > 0 ? roundTo(acc.packetLossPercentTotal / acc.packetLossSamples, 2) : 0,
    jitterMs: acc.jitterSamples > 0 ? roundTo(acc.jitterMsTotal / acc.jitterSamples, 1) : 0,
    audioCodec: acc.audioCodec,
    audioBitrateKbps: acc.audioBitrateKbps,
    audioJitterBufferMs:
      acc.audioJitterBufferSamples > 0
        ? roundTo(acc.audioJitterBufferMsTotal / acc.audioJitterBufferSamples, 1)
        : 0,
    audioPacketsLost: acc.audioPacketsLost,
    peerStats: acc.peerStats,
  };
};
