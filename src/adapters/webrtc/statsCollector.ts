import { EMPTY_AUDIO_TELEMETRY } from '../../domain/config';
import {
  AudioTelemetryDto,
  PeerTelemetryDto,
  StreamQualityLimitationReason,
} from '../../domain/dtos';
import { WebRtcStatsSnapshot } from '../../ports';
import {
  AudioDirectionAccumulator,
  AudioTrackMeta,
  ReceivingAudioTrackState,
  averageStat,
  createAudioDirectionAccumulator,
  finalizeAudioTelemetry,
  getReceivingAudioTrackState,
  normalizeCodecLabel,
  readAudioTrackMetadata,
  readVideoTrackMetadata,
  resolveAudioCodecDetails,
  roundStat,
  updateJitterBufferDeltaMs,
} from './mediaTrackStats';
import {
  BitrateSample,
  PacketLossSample,
  PeerEntry,
  StatsSampleTracker,
  createStatsSampleTracker,
} from './peerTypes';

const HW_CODEC_PATTERN =
  /mediafoundation|nvenc|qsv|quicksync|amf|vce|vaapi|videotoolbox|mediacodec|externalencoder|externaldecoder|d3d11|dxva/i;
const SW_CODEC_PATTERN = /libvpx|openh264|libaom|ffmpeg|software|dav1d/i;

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
  outboundFps: number;
  outboundWidth: number;
  outboundHeight: number;
  outboundCodec: string;
  encoderImplementation: string;
  isEncoderHardwareAccelerated: boolean | null;
  outboundQualityLimitationReason: StreamQualityLimitationReason;
  outboundAudio: AudioDirectionAccumulator;
  inboundBitrateKbps: number;
  inboundFps: number;
  inboundWidth: number;
  inboundHeight: number;
  inboundDroppedFrames: number;
  inboundCodec: string;
  decoderImplementation: string;
  isDecoderHardwareAccelerated: boolean | null;
  inboundAudio: AudioDirectionAccumulator;
  selectedPairId: string;
  dtlsState: string;
  candidatePairs: CandidatePairRtt[];
  remoteInboundRttMs: number[];
  videoLossSamples: number[];
  jitterMsSamples: number[];
}

interface GlobalAccumulator {
  outboundFps: number;
  inboundFps: number;
  outboundWidth: number;
  outboundHeight: number;
  droppedFrames: number;
  rttMs: number;
  rttSamples: number;
  activeCodec: string;
  isHardwareAccelerated: boolean | null;
  encoderImplementation: string;
  qualityLimitationReason: StreamQualityLimitationReason;
  outboundBitrateKbps: number;
  inboundBitrateKbps: number;
  packetLossPercentTotal: number;
  packetLossSamples: number;
  jitterMsTotal: number;
  jitterSamples: number;
  audioCodec: string;
  inboundAudioBitrateTotal: number;
  outboundAudioBitrates: number[];
  outboundAudioCodec: string;
  outboundAudioSampleRateHz: number;
  outboundAudioChannels: number;
  outboundAudioHasRtp: boolean;
  outboundAudioPacketsLost: number;
  outboundAudioLossSamples: number[];
  outboundAudioJitterSamples: number[];
  outboundAudioLevel: number | null;
  audioJitterBufferMsTotal: number;
  audioJitterBufferSamples: number;
  audioPacketsLost: number;
  peerStats: Record<string, PeerTelemetryDto>;
}

interface StatContext {
  peerIdSafe: string;
  entry: PeerEntry;
  report: RTCStatsReport;
  tracker: StatsSampleTracker;
  acc: GlobalAccumulator;
  peerAcc: PeerStatsAccumulator;
  localAudioMeta: AudioTrackMeta;
  receivingAudioState: ReceivingAudioTrackState;
}

const createPeerAccumulator = (): PeerStatsAccumulator => ({
  outboundBitrateKbps: 0,
  outboundFps: 0,
  outboundWidth: 0,
  outboundHeight: 0,
  outboundCodec: '',
  encoderImplementation: '',
  isEncoderHardwareAccelerated: null,
  outboundQualityLimitationReason: 'none',
  outboundAudio: createAudioDirectionAccumulator(),
  inboundBitrateKbps: 0,
  inboundFps: 0,
  inboundWidth: 0,
  inboundHeight: 0,
  inboundDroppedFrames: 0,
  inboundCodec: '',
  decoderImplementation: '',
  isDecoderHardwareAccelerated: null,
  inboundAudio: createAudioDirectionAccumulator(),
  selectedPairId: '',
  dtlsState: '',
  candidatePairs: [],
  remoteInboundRttMs: [],
  videoLossSamples: [],
  jitterMsSamples: [],
});

const normalizeQualityLimitation = (value: unknown): StreamQualityLimitationReason => {
  if (value === 'cpu' || value === 'bandwidth' || value === 'other' || value === 'none') {
    return value;
  }
  return 'none';
};

/** Infers whether an encoder or decoder runs on GPU hardware vs CPU software. */
export const inferHardwareAcceleration = (
  powerEfficientFlag: unknown,
  implementation: string
): boolean | null => {
  if (typeof powerEfficientFlag === 'boolean') return powerEfficientFlag;
  if (!implementation) return null;
  if (HW_CODEC_PATTERN.test(implementation)) return true;
  if (SW_CODEC_PATTERN.test(implementation)) return false;
  return null;
};

/** Backwards-compatible alias for encoder hardware classification tests/callers. */
export const inferHardwareEncoder = inferHardwareAcceleration;

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

  const width = Math.max(0, Math.round(Number(stat.frameWidth ?? 0)));
  const height = Math.max(0, Math.round(Number(stat.frameHeight ?? 0)));
  if (width > peerAcc.outboundWidth) peerAcc.outboundWidth = width;
  if (height > peerAcc.outboundHeight) peerAcc.outboundHeight = height;
  if (width > acc.outboundWidth) acc.outboundWidth = width;
  if (height > acc.outboundHeight) acc.outboundHeight = height;

  const isActive =
    fps > 0 ||
    Number(stat.bytesSent ?? 0) > 0 ||
    Number(stat.framesSent ?? 0) > 0 ||
    Number(stat.framesEncoded ?? 0) > 0;
  if (!isActive) return;

  const kbps = updateBitrateFromSample(peerIdSafe, stat, 'out', tracker.bitrate);
  acc.outboundBitrateKbps += kbps;
  peerAcc.outboundBitrateKbps += kbps;

  const codec = resolveReportCodecName(report, stat.codecId);
  if (codec) {
    if (!peerAcc.outboundCodec) peerAcc.outboundCodec = codec;
    if (!acc.activeCodec) acc.activeCodec = codec;
  }

  const impl = typeof stat.encoderImplementation === 'string' ? stat.encoderImplementation.trim() : '';
  if (impl) {
    if (!peerAcc.encoderImplementation) peerAcc.encoderImplementation = impl;
    if (!acc.encoderImplementation) acc.encoderImplementation = impl;
  }

  const hwDetected = inferHardwareAcceleration(stat.powerEfficientEncoder, impl);
  if (hwDetected !== null) {
    peerAcc.isEncoderHardwareAccelerated =
      peerAcc.isEncoderHardwareAccelerated === false ? false : hwDetected;
    acc.isHardwareAccelerated = acc.isHardwareAccelerated === false ? false : hwDetected;
  }

  const limitation = normalizeQualityLimitation(stat.qualityLimitationReason);
  if (LIMITATION_PRIORITY[limitation] > LIMITATION_PRIORITY[peerAcc.outboundQualityLimitationReason]) {
    peerAcc.outboundQualityLimitationReason = limitation;
  }
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

  const width = Math.max(0, Math.round(Number(stat.frameWidth ?? 0)));
  const height = Math.max(0, Math.round(Number(stat.frameHeight ?? 0)));
  if (width > peerAcc.inboundWidth) peerAcc.inboundWidth = width;
  if (height > peerAcc.inboundHeight) peerAcc.inboundHeight = height;

  const dropped = Math.max(0, Number(stat.framesDropped ?? 0));
  acc.droppedFrames += dropped;
  peerAcc.inboundDroppedFrames += dropped;

  const isActive =
    fps > 0 ||
    Number(stat.bytesReceived ?? 0) > 0 ||
    Number(stat.framesDecoded ?? 0) > 0 ||
    Number(stat.packetsReceived ?? 0) > 0;

  if (isActive) {
    const kbps = updateBitrateFromSample(peerIdSafe, stat, 'in', tracker.bitrate);
    acc.inboundBitrateKbps += kbps;
    peerAcc.inboundBitrateKbps += kbps;

    const codec = resolveReportCodecName(report, stat.codecId);
    if (codec) {
      if (!peerAcc.inboundCodec) peerAcc.inboundCodec = codec;
      if (!acc.activeCodec) acc.activeCodec = codec;
    }

    const decoderImpl =
      typeof stat.decoderImplementation === 'string' ? stat.decoderImplementation.trim() : '';
    if (decoderImpl && !peerAcc.decoderImplementation) {
      peerAcc.decoderImplementation = decoderImpl;
    }
    const hwDec = inferHardwareAcceleration(stat.powerEfficientDecoder, decoderImpl);
    if (hwDec !== null) {
      peerAcc.isDecoderHardwareAccelerated =
        peerAcc.isDecoderHardwareAccelerated === false ? false : hwDec;
    }
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
  const audioAcc = direction === 'out' ? peerAcc.outboundAudio : peerAcc.inboundAudio;
  const bytes = Number((direction === 'out' ? stat.bytesSent : stat.bytesReceived) ?? 0);
  const packets = Number((direction === 'out' ? stat.packetsSent : stat.packetsReceived) ?? 0);
  const isActive = bytes > 0 || packets > 0;

  if (!isActive) return;

  const kbps = updateBitrateFromSample(peerIdSafe, stat, direction, tracker.bitrate);
  if (direction === 'out' && ctx.localAudioMeta.liveTrackCount === 0) {
    return;
  }
  if (
    direction === 'in' &&
    ctx.receivingAudioState.hasAudioTransceivers &&
    !ctx.receivingAudioState.hasAnyActiveReceiver
  ) {
    return;
  }

  audioAcc.hasActiveRtp = true;
  audioAcc.bitrateKbps += kbps;

  const codecInfo = resolveAudioCodecDetails(report, stat.codecId);
  if (codecInfo.codec) {
    if (!audioAcc.codec) audioAcc.codec = codecInfo.codec;
    if (!acc.audioCodec) acc.audioCodec = codecInfo.codec;
  }
  if (codecInfo.sampleRateHz > 0 && audioAcc.sampleRateHz === 0) {
    audioAcc.sampleRateHz = codecInfo.sampleRateHz;
  }
  if (codecInfo.channels > 0 && audioAcc.channels === 0) {
    audioAcc.channels = codecInfo.channels;
  }

  if (direction === 'out') {
    if (typeof stat.mediaSourceId === 'string' && stat.mediaSourceId) {
      const mediaSource = report.get(stat.mediaSourceId) as Record<string, unknown> | undefined;
      if (typeof mediaSource?.audioLevel === 'number' && Number.isFinite(mediaSource.audioLevel)) {
        audioAcc.audioLevel = mediaSource.audioLevel;
      }
    }
    return;
  }

  acc.inboundAudioBitrateTotal += kbps;
  const lost = Math.max(0, Number(stat.packetsLost ?? 0));
  audioAcc.packetsLost += lost;
  acc.audioPacketsLost += lost;

  if (typeof stat.jitter === 'number' && Number.isFinite(stat.jitter) && stat.jitter >= 0) {
    const jMs = stat.jitter * 1000;
    audioAcc.jitterMsTotal += jMs;
    audioAcc.jitterSamples += 1;
    peerAcc.jitterMsSamples.push(jMs);
  }

  if (typeof stat.audioLevel === 'number' && Number.isFinite(stat.audioLevel)) {
    audioAcc.audioLevel = stat.audioLevel;
  }

  const jbMs = updateJitterBufferDeltaMs(peerIdSafe, stat, tracker.jitterBuffer);
  if (jbMs !== null) {
    audioAcc.jitterBufferMsTotal += jbMs;
    audioAcc.jitterBufferSamples += 1;
    acc.audioJitterBufferMsTotal += jbMs;
    acc.audioJitterBufferSamples += 1;
  }

  accumulateInboundMediaLoss(stat, 'in-audio', ctx, audioAcc.lossSamples);
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

  const rttSec = Number(stat.roundTripTime ?? 0);
  if (Number.isFinite(rttSec) && rttSec > 0) {
    ctx.peerAcc.remoteInboundRttMs.push(rttSec * 1000);
  }

  recordJitterSample(stat, true, ctx.peerAcc);
  const lossPct = resolveRemoteInboundLoss(stat, ctx);

  if (stat.kind === 'video') {
    if (lossPct !== null) ctx.peerAcc.videoLossSamples.push(lossPct);
    return;
  }

  if (ctx.localAudioMeta.liveTrackCount === 0) return;

  const lost = Math.max(0, Number(stat.packetsLost ?? 0));
  ctx.peerAcc.outboundAudio.packetsLost += lost;
  if (typeof stat.jitter === 'number' && Number.isFinite(stat.jitter) && stat.jitter >= 0) {
    ctx.peerAcc.outboundAudio.jitterMsTotal += stat.jitter * 1000;
    ctx.peerAcc.outboundAudio.jitterSamples += 1;
  }
  if (lossPct !== null) {
    ctx.peerAcc.outboundAudio.lossSamples.push(lossPct);
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
  } else if (stat.type === 'transport') {
    if (typeof stat.selectedCandidatePairId === 'string') {
      ctx.peerAcc.selectedPairId = stat.selectedCandidatePairId;
    }
    if (typeof stat.dtlsState === 'string' && !ctx.peerAcc.dtlsState) {
      ctx.peerAcc.dtlsState = stat.dtlsState;
    }
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
  if (peerAcc.candidatePairs.length > 0) return averageStat(peerAcc.candidatePairs.map((p) => p.rttMs));
  if (peerAcc.remoteInboundRttMs.length > 0) return averageStat(peerAcc.remoteInboundRttMs);
  return 0;
};

const recordLocalAudioPeerContribution = (
  outboundAudio: AudioTelemetryDto,
  peerAcc: PeerStatsAccumulator,
  acc: GlobalAccumulator
): void => {
  if (peerAcc.outboundAudio.hasActiveRtp) {
    acc.outboundAudioHasRtp = true;
    acc.outboundAudioBitrates.push(outboundAudio.bitrateKbps);
    if (!acc.outboundAudioCodec && outboundAudio.codec) acc.outboundAudioCodec = outboundAudio.codec;
    if (acc.outboundAudioSampleRateHz === 0 && outboundAudio.sampleRateHz > 0) {
      acc.outboundAudioSampleRateHz = outboundAudio.sampleRateHz;
    }
    if (acc.outboundAudioChannels === 0 && outboundAudio.channels > 0) {
      acc.outboundAudioChannels = outboundAudio.channels;
    }
    if (outboundAudio.audioLevel !== null) {
      acc.outboundAudioLevel = outboundAudio.audioLevel;
    }
  }
  acc.outboundAudioPacketsLost += outboundAudio.packetsLost;
  acc.outboundAudioLossSamples.push(...peerAcc.outboundAudio.lossSamples);
  if (peerAcc.outboundAudio.jitterSamples > 0) {
    acc.outboundAudioJitterSamples.push(
      peerAcc.outboundAudio.jitterMsTotal / peerAcc.outboundAudio.jitterSamples
    );
  }
};

const finalizePeerTelemetry = (
  entry: PeerEntry,
  peerAcc: PeerStatsAccumulator,
  acc: GlobalAccumulator,
  localAudioMeta: AudioTrackMeta
): PeerTelemetryDto => {
  const rawRttMs = resolvePeerRttMs(peerAcc);
  if (rawRttMs > 0) {
    acc.rttMs += rawRttMs;
    acc.rttSamples += 1;
  }

  const remoteAudioMeta = readAudioTrackMetadata(entry.remoteStream, entry.pc);
  const remoteVideoMeta = readVideoTrackMetadata(entry.remoteStream);
  const inboundAudio = finalizeAudioTelemetry(peerAcc.inboundAudio, remoteAudioMeta);
  const outboundAudio = finalizeAudioTelemetry(peerAcc.outboundAudio, localAudioMeta);
  recordLocalAudioPeerContribution(outboundAudio, peerAcc, acc);

  const lossSource =
    peerAcc.videoLossSamples.length > 0
      ? peerAcc.videoLossSamples
      : peerAcc.inboundAudio.lossSamples;
  const packetLossPercent = roundStat(averageStat(lossSource), 2);
  if (lossSource.length > 0) {
    acc.packetLossPercentTotal += packetLossPercent;
    acc.packetLossSamples += 1;
  }

  const jitterMs = roundStat(averageStat(peerAcc.jitterMsSamples), 1);
  if (peerAcc.jitterMsSamples.length > 0) {
    acc.jitterMsTotal += jitterMs;
    acc.jitterSamples += 1;
  }

  const inboundWidth = peerAcc.inboundWidth > 0 ? peerAcc.inboundWidth : remoteVideoMeta.width;
  const inboundHeight = peerAcc.inboundHeight > 0 ? peerAcc.inboundHeight : remoteVideoMeta.height;
  const inboundFps = Math.round(
    peerAcc.inboundFps > 0 ? peerAcc.inboundFps : remoteVideoMeta.frameRate
  );

  return {
    peerIdSafe: entry.peerIdSafe,
    rttMs: Math.round(rawRttMs),
    inboundBitrateKbps: peerAcc.inboundBitrateKbps,
    inboundFps,
    inboundWidth,
    inboundHeight,
    inboundDroppedFrames: peerAcc.inboundDroppedFrames,
    inboundCodec: peerAcc.inboundCodec,
    decoderImplementation: peerAcc.decoderImplementation,
    isDecoderHardwareAccelerated: peerAcc.isDecoderHardwareAccelerated,
    inboundAudio,
    outboundBitrateKbps: peerAcc.outboundBitrateKbps,
    outboundFps: Math.round(peerAcc.outboundFps),
    outboundWidth: peerAcc.outboundWidth,
    outboundHeight: peerAcc.outboundHeight,
    outboundCodec: peerAcc.outboundCodec,
    encoderImplementation: peerAcc.encoderImplementation,
    isEncoderHardwareAccelerated: peerAcc.isEncoderHardwareAccelerated,
    outboundQualityLimitationReason: peerAcc.outboundQualityLimitationReason,
    outboundAudio,
    bitrateKbps: peerAcc.inboundBitrateKbps,
    fps: inboundFps,
    packetLossPercent,
    jitterMs,
    connectionState: entry.pc.connectionState ?? 'unknown',
    dataChannelState: entry.dataChannel?.readyState ?? 'closed',
    dtlsState: peerAcc.dtlsState,
  };
};

const collectPeerStats = async (
  entry: PeerEntry,
  tracker: StatsSampleTracker,
  acc: GlobalAccumulator,
  localAudioMeta: AudioTrackMeta
): Promise<void> => {
  if (entry.pc.connectionState === 'closed') return;
  const peerAcc = createPeerAccumulator();
  const receivingAudioState = getReceivingAudioTrackState(entry.pc);

  try {
    const report = await entry.pc.getStats();
    const ctx: StatContext = {
      peerIdSafe: entry.peerIdSafe,
      entry,
      report,
      tracker,
      acc,
      peerAcc,
      localAudioMeta,
      receivingAudioState,
    };
    report.forEach((statEntry) => {
      accumulateStatReport(statEntry as unknown as Record<string, unknown>, ctx);
    });
  } catch {
    // Peer may close concurrently while stats are polled.
  }

  acc.peerStats[entry.peerIdSafe] = finalizePeerTelemetry(entry, peerAcc, acc, localAudioMeta);
};

const buildLocalAudioTelemetry = (
  localAudioMeta: AudioTrackMeta,
  acc: GlobalAccumulator
): AudioTelemetryDto => {
  const hasAudio = localAudioMeta.liveTrackCount > 0 || acc.outboundAudioHasRtp;
  if (!hasAudio) {
    return { ...EMPTY_AUDIO_TELEMETRY };
  }

  return {
    hasAudio: true,
    trackCount:
      localAudioMeta.liveTrackCount > 0
        ? localAudioMeta.liveTrackCount
        : acc.outboundAudioHasRtp
          ? 1
          : 0,
    codec: acc.outboundAudioCodec || acc.audioCodec,
    sampleRateHz:
      localAudioMeta.sampleRateHz > 0 ? localAudioMeta.sampleRateHz : acc.outboundAudioSampleRateHz,
    channels: localAudioMeta.channels > 0 ? localAudioMeta.channels : acc.outboundAudioChannels,
    bitrateKbps: Math.round(averageStat(acc.outboundAudioBitrates)),
    jitterBufferMs: 0,
    jitterMs:
      acc.outboundAudioJitterSamples.length > 0
        ? roundStat(averageStat(acc.outboundAudioJitterSamples), 1)
        : 0,
    packetsLost: Math.max(0, acc.outboundAudioPacketsLost),
    packetLossPercent:
      acc.outboundAudioLossSamples.length > 0
        ? roundStat(averageStat(acc.outboundAudioLossSamples), 2)
        : 0,
    audioLevel: acc.outboundAudioLevel,
  };
};

/**
 * Aggregates outbound/inbound video FPS, resolutions, dropped frames, RTT,
 * active codecs/accelerators, bitrates, packet loss, jitter, local/remote audio
 * telemetry, and per-peer telemetry across all active WebRTC peers.
 */
export const collectWebRtcStats = async (
  peers: Iterable<PeerEntry>,
  tracker: StatsSampleTracker = createStatsSampleTracker(),
  localStream: MediaStream | null = null
): Promise<WebRtcStatsSnapshot> => {
  const localVideoMeta = readVideoTrackMetadata(localStream);
  const localAudioMeta = readAudioTrackMetadata(localStream);

  const acc: GlobalAccumulator = {
    outboundFps: 0,
    inboundFps: 0,
    outboundWidth: 0,
    outboundHeight: 0,
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
    inboundAudioBitrateTotal: 0,
    outboundAudioBitrates: [],
    outboundAudioCodec: '',
    outboundAudioSampleRateHz: 0,
    outboundAudioChannels: 0,
    outboundAudioHasRtp: false,
    outboundAudioPacketsLost: 0,
    outboundAudioLossSamples: [],
    outboundAudioJitterSamples: [],
    outboundAudioLevel: null,
    audioJitterBufferMsTotal: 0,
    audioJitterBufferSamples: 0,
    audioPacketsLost: 0,
    peerStats: {},
  };

  for (const entry of peers) {
    await collectPeerStats(entry, tracker, acc, localAudioMeta);
  }

  const localAudio = buildLocalAudioTelemetry(localAudioMeta, acc);

  return {
    outboundFps: acc.outboundFps,
    inboundFps: acc.inboundFps,
    localWidth: acc.outboundWidth > 0 ? acc.outboundWidth : localVideoMeta.width,
    localHeight: acc.outboundHeight > 0 ? acc.outboundHeight : localVideoMeta.height,
    localCaptureFps: localVideoMeta.frameRate,
    droppedFrames: acc.droppedFrames,
    rttMs: acc.rttSamples > 0 ? acc.rttMs / acc.rttSamples : 0,
    activeCodec: acc.activeCodec,
    isHardwareAccelerated: acc.isHardwareAccelerated,
    encoderImplementation: acc.encoderImplementation,
    qualityLimitationReason: acc.qualityLimitationReason,
    outboundBitrateKbps: acc.outboundBitrateKbps,
    inboundBitrateKbps: acc.inboundBitrateKbps,
    packetLossPercent:
      acc.packetLossSamples > 0 ? roundStat(acc.packetLossPercentTotal / acc.packetLossSamples, 2) : 0,
    jitterMs: acc.jitterSamples > 0 ? roundStat(acc.jitterMsTotal / acc.jitterSamples, 1) : 0,
    audioCodec: acc.audioCodec || localAudio.codec,
    audioBitrateKbps:
      acc.inboundAudioBitrateTotal > 0 ? acc.inboundAudioBitrateTotal : localAudio.bitrateKbps,
    audioJitterBufferMs:
      acc.audioJitterBufferSamples > 0
        ? roundStat(acc.audioJitterBufferMsTotal / acc.audioJitterBufferSamples, 1)
        : 0,
    audioPacketsLost: acc.audioPacketsLost,
    localAudio,
    peerStats: acc.peerStats,
  };
};
