import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { systemMonitorAdapter, telemetryAdapter, webrtcStreamEngine } from '../adapters';
import {
  PeerTelemetryHistoryPointDto,
  RoomRole,
  StreamFpsOption,
  StreamResolutionPreset,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
} from '../domain/dtos';
import {
  EMPTY_METRICS,
  METRICS_POLL_MS,
  toCpuTier,
  toRamTier,
  toRttBucket,
} from './room/roomHelpers';

const MAX_TELEMETRY_HISTORY_SAMPLES = 450;
const MAX_PEER_TELEMETRY_SAMPLES = 450;

export interface UseRoomMetricsOptions {
  normalizedHub: string;
  hasLeftRoom: boolean;
  mountedRef: MutableRefObject<boolean>;
  roleRef: MutableRefObject<RoomRole>;
  fpsRef: MutableRefObject<StreamFpsOption>;
  resolutionRef: MutableRefObject<StreamResolutionPreset>;
}

const buildHighLoadAdvice = (
  metrics: SystemMetricsDto,
  currentFps: StreamFpsOption,
  currentResolution: StreamResolutionPreset
): string => {
  const swFallbackNote =
    metrics.isHardwareAccelerated === false && metrics.activeCodec
      ? `Software CPU encoder active (${metrics.activeCodec})`
      : metrics.qualityLimitationReason === 'cpu'
        ? 'CPU encoder bottleneck detected'
        : 'High CPU/GPU load detected';

  if (currentFps === 120) {
    return `${swFallbackNote} — consider dropping from 120 FPS to 60 FPS.`;
  }
  if (currentFps === 60 && currentResolution !== '720p') {
    return `${swFallbackNote} — consider switching to 720p or 30 FPS while gaming.`;
  }
  if (currentFps === 60) {
    return `${swFallbackNote} — consider switching to 30 FPS.`;
  }
  return `${swFallbackNote} — consider switching to 720p to free game headroom.`;
};

const appendBoundedSample = <T>(existing: T[], point: T, limit: number): T[] => {
  if (existing.length >= limit) {
    return [...existing.slice(existing.length - limit + 1), point];
  }
  return [...existing, point];
};

const buildTelemetryPoint = (
  metrics: SystemMetricsDto,
  timestamp: number
): TelemetryHistoryPointDto => ({
  timestamp,
  bitrateKbps: metrics.outboundBitrateKbps,
  outboundFps: metrics.outboundFps,
  inboundFps: metrics.inboundFps,
  rttMs: metrics.rttMs,
  packetLossPercent: metrics.packetLossPercent,
  jitterMs: metrics.jitterMs,
  cpuUsagePercent: metrics.cpuUsagePercent,
  memoryUsedMb: metrics.memoryUsedMb,
  droppedFrames: metrics.droppedFrames,
  audioJitterBufferMs: metrics.audioJitterBufferMs,
  audioBitrateKbps: metrics.localAudio.bitrateKbps,
});

export interface UseRoomMetricsResult {
  systemMetrics: SystemMetricsDto;
  telemetryHistory: TelemetryHistoryPointDto[];
  peerTelemetryHistory: Record<string, PeerTelemetryHistoryPointDto[]>;
  highLoadSuggestion: string | null;
  recordPongRtt: (measuredMs: number) => void;
  dismissHighLoadSuggestion: () => void;
}

/**
 * Polls OS CPU/RAM and WebRTC FPS/RTT metrics on `METRICS_POLL_MS`, independently
 * of peer keepalive ping/pong timers, maintains rolling telemetry histories, and
 * emits high-load suggestions.
 */
export const useRoomMetrics = ({
  normalizedHub,
  hasLeftRoom,
  mountedRef,
  roleRef,
  fpsRef,
  resolutionRef,
}: UseRoomMetricsOptions): UseRoomMetricsResult => {
  const [systemMetrics, setSystemMetrics] = useState<SystemMetricsDto>(EMPTY_METRICS);
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryHistoryPointDto[]>([]);
  const [peerTelemetryHistory, setPeerTelemetryHistory] = useState<
    Record<string, PeerTelemetryHistoryPointDto[]>
  >({});
  const [highLoadSuggestion, setHighLoadSuggestion] = useState<string | null>(null);

  const dcRttRef = useRef<number>(0);
  const lastHighLoadRef = useRef<boolean>(false);
  const highLoadDismissedRef = useRef<boolean>(false);
  const metricsEpochRef = useRef<number>(0);

  const recordPongRtt = useCallback(
    (measuredMs: number): void => {
      dcRttRef.current = measuredMs;
      if (mountedRef.current) {
        setSystemMetrics((prev) => ({
          ...prev,
          rttMs: prev.rttMs > 0 ? prev.rttMs : measuredMs,
        }));
      }
    },
    [mountedRef]
  );

  const dismissHighLoadSuggestion = useCallback((): void => {
    highLoadDismissedRef.current = true;
    setHighLoadSuggestion(null);
  }, []);

  const sampleSystemMetricsOnce = useCallback(async (): Promise<void> => {
    const epoch = metricsEpochRef.current;
    const sampled = await systemMonitorAdapter.sampleMetrics(webrtcStreamEngine);
    if (!mountedRef.current || epoch !== metricsEpochRef.current) return;

    const now = Date.now();
    const effectiveRtt = sampled.rttMs > 0 ? sampled.rttMs : dcRttRef.current;
    const merged: SystemMetricsDto = { ...sampled, rttMs: effectiveRtt };
    setSystemMetrics(merged);

    const historyPoint = buildTelemetryPoint(merged, now);
    setTelemetryHistory((prev) =>
      appendBoundedSample(prev, historyPoint, MAX_TELEMETRY_HISTORY_SAMPLES)
    );

    const peerEntries = Object.entries(merged.peerStats ?? {});
    setPeerTelemetryHistory((prev) => {
      if (peerEntries.length === 0 && Object.keys(prev).length === 0) {
        return prev;
      }
      const next: Record<string, PeerTelemetryHistoryPointDto[]> = {};
      for (const [peerIdSafe, stats] of peerEntries) {
        const point: PeerTelemetryHistoryPointDto = {
          timestamp: now,
          rttMs: stats.rttMs,
          bitrateKbps: stats.inboundBitrateKbps,
          inboundBitrateKbps: stats.inboundBitrateKbps,
          outboundBitrateKbps: stats.outboundBitrateKbps,
          fps: stats.inboundFps,
          inboundFps: stats.inboundFps,
          outboundFps: stats.outboundFps,
          packetLossPercent: stats.packetLossPercent,
          jitterMs: stats.jitterMs,
          droppedFrames: stats.inboundDroppedFrames,
        };
        next[peerIdSafe] = appendBoundedSample(
          prev[peerIdSafe] ?? [],
          point,
          MAX_PEER_TELEMETRY_SAMPLES
        );
      }
      return next;
    });

    if (merged.qualityLimitationReason === 'cpu') {
      void webrtcStreamEngine.setCpuThrottleFactor(0.72);
    } else if (!merged.highLoadWarning) {
      void webrtcStreamEngine.setCpuThrottleFactor(1.0);
    }

    if (merged.highLoadWarning && !lastHighLoadRef.current) {
      highLoadDismissedRef.current = false;
      void telemetryAdapter.trackEvent('high_load_detected', {
        role: roleRef.current,
        fps: fpsRef.current,
        cpuTier: toCpuTier(merged.cpuUsagePercent),
        ramTier: toRamTier(merged.memoryUsedMb, merged.memoryTotalMb),
        rttBucket: toRttBucket(effectiveRtt),
      });
    }
    lastHighLoadRef.current = merged.highLoadWarning;

    if (!merged.highLoadWarning) {
      setHighLoadSuggestion(null);
      return;
    }

    if (highLoadDismissedRef.current) return;
    setHighLoadSuggestion(buildHighLoadAdvice(merged, fpsRef.current, resolutionRef.current));
  }, [fpsRef, mountedRef, resolutionRef, roleRef]);

  useEffect(() => {
    metricsEpochRef.current += 1;
    dcRttRef.current = 0;
    lastHighLoadRef.current = false;
    highLoadDismissedRef.current = false;
    setSystemMetrics(EMPTY_METRICS);
    setTelemetryHistory([]);
    setPeerTelemetryHistory({});
    setHighLoadSuggestion(null);

    if (!normalizedHub || hasLeftRoom) return;
    void sampleSystemMetricsOnce();
    const timer = window.setInterval(() => {
      void sampleSystemMetricsOnce();
    }, METRICS_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasLeftRoom, normalizedHub, sampleSystemMetricsOnce]);

  return {
    systemMetrics,
    telemetryHistory,
    peerTelemetryHistory,
    highLoadSuggestion,
    recordPongRtt,
    dismissHighLoadSuggestion,
  };
};
