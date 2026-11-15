import React, { useMemo, useState } from 'react';
import styles from './TelemetryPanel.module.css';
import {
  StreamFpsOption,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
} from '../../domain/dtos';
import { BitrateAreaChart, FpsLineChart, SparklineChart } from './TelemetryCharts';

export type TelemetryWindowKey = '1m' | '5m' | '15m';

export interface TelemetryPanelProps {
  fps: StreamFpsOption;
  isConnected: boolean;
  systemMetrics: SystemMetricsDto;
  telemetryHistory: TelemetryHistoryPointDto[];
  hasActiveAudioStreams?: boolean;
}

const WINDOW_CONFIG: Record<
  TelemetryWindowKey,
  { ms: number; startLabel: string; midLabel: string }
> = {
  '1m': { ms: 60_000, startLabel: '-60s', midLabel: '-30s' },
  '5m': { ms: 300_000, startLabel: '-5m', midLabel: '-2.5m' },
  '15m': { ms: 900_000, startLabel: '-15m', midLabel: '-7.5m' },
};

const WINDOW_KEYS: TelemetryWindowKey[] = ['1m', '5m', '15m'];

const sliceHistoryByWindow = (
  history: TelemetryHistoryPointDto[],
  windowKey: TelemetryWindowKey
): TelemetryHistoryPointDto[] => {
  if (history.length === 0) return [];
  const latestTimestamp = history[history.length - 1].timestamp;
  const cutoff = latestTimestamp - WINDOW_CONFIG[windowKey].ms;
  return history.filter((point) => point.timestamp >= cutoff);
};

const formatRelativeTime = (timestamp: number, latestTimestamp: number): string => {
  const diffSec = Math.max(0, Math.round((latestTimestamp - timestamp) / 1000));
  if (diffSec === 0) return 'Now';
  if (diffSec < 60) return `-${diffSec}s`;
  const mins = Math.floor(diffSec / 60);
  const remSec = diffSec % 60;
  return remSec > 0 ? `-${mins}m ${remSec}s` : `-${mins}m`;
};

const computeFpsJitter = (fpsValues: number[]): number => {
  const nonZero = fpsValues.filter((val) => val > 0);
  if (nonZero.length < 2) return 0;
  let totalDelta = 0;
  for (let i = 1; i < nonZero.length; i += 1) {
    totalDelta += Math.abs(nonZero[i] - nonZero[i - 1]);
  }
  return Math.round((totalDelta / (nonZero.length - 1)) * 10) / 10;
};

const getSmoothnessRating = (
  currentFps: number,
  targetFps: number,
  jitterFps: number,
  droppedFrames: number
): { label: 'High Smoothness' | 'Moderate' | 'Low'; className: string } => {
  if (currentFps <= 0) {
    if (droppedFrames > 5) {
      return { label: 'Moderate', className: styles.statusWarn };
    }
    return { label: 'High Smoothness', className: styles.statusGood };
  }

  const ratio = targetFps > 0 ? currentFps / targetFps : 1;
  if (ratio >= 0.85 && jitterFps <= 3) {
    return { label: 'High Smoothness', className: styles.statusGood };
  }
  if (ratio >= 0.55 && jitterFps <= 8) {
    return { label: 'Moderate', className: styles.statusWarn };
  }
  return { label: 'Low', className: styles.statusError };
};

const computeChannelHealthPercent = (
  isConnected: boolean,
  metrics: SystemMetricsDto
): number => {
  if (!isConnected) return 0;
  const peerEntries = Object.values(metrics.peerStats ?? {});
  if (peerEntries.length === 0) return 100;

  let scoreSum = 0;
  for (const peer of peerEntries) {
    const dcOk = peer.dataChannelState === 'open' ? 1 : 0.4;
    const pcOk =
      peer.connectionState === 'connected'
        ? 1
        : peer.connectionState === 'connecting' || peer.connectionState === 'new'
          ? 0.75
          : 0.25;
    scoreSum += ((dcOk + pcOk) / 2) * 100;
  }
  return Math.max(0, Math.min(100, Math.round(scoreSum / peerEntries.length)));
};

const formatEncoderLabel = (metrics: SystemMetricsDto): string => {
  if (metrics.encoderImplementation) return metrics.encoderImplementation;
  if (metrics.isHardwareAccelerated === true) return 'HW';
  if (metrics.isHardwareAccelerated === false) return 'SW';
  return 'Auto';
};

export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
  fps,
  isConnected,
  systemMetrics,
  telemetryHistory,
  hasActiveAudioStreams = false,
}) => {
  const [selectedWindow, setSelectedWindow] = useState<TelemetryWindowKey>('1m');

  const slicedHistory = useMemo(
    () => sliceHistoryByWindow(telemetryHistory, selectedWindow),
    [selectedWindow, telemetryHistory]
  );

  const windowMeta = WINDOW_CONFIG[selectedWindow];
  const latestTimestamp =
    slicedHistory.length > 0 ? slicedHistory[slicedHistory.length - 1].timestamp : Date.now();

  const currentBitrateKbps = Math.round(
    systemMetrics.outboundBitrateKbps > 0
      ? systemMetrics.outboundBitrateKbps
      : systemMetrics.inboundBitrateKbps
  );

  const bitrateChartData = useMemo(() => {
    if (slicedHistory.length > 0) {
      return slicedHistory.map((point) => ({
        timeLabel: formatRelativeTime(point.timestamp, latestTimestamp),
        value: Math.round(point.bitrateKbps),
      }));
    }
    if (currentBitrateKbps > 0) {
      return [{ timeLabel: 'Now', value: currentBitrateKbps }];
    }
    return [];
  }, [currentBitrateKbps, latestTimestamp, slicedHistory]);

  const bitrateValues = bitrateChartData.map((item) => item.value);
  const peakBitrate = bitrateValues.length > 0 ? Math.max(...bitrateValues) : currentBitrateKbps;
  const nonZeroBitrates = bitrateValues.filter((val) => val > 0);
  const minBitrate =
    nonZeroBitrates.length > 0 ? Math.min(...nonZeroBitrates) : currentBitrateKbps;

  const currentFps = Math.round(
    systemMetrics.outboundFps > 0 ? systemMetrics.outboundFps : systemMetrics.inboundFps
  );

  const fpsChartData = useMemo(() => {
    if (slicedHistory.length > 0) {
      return slicedHistory.map((point) => ({
        timeLabel: formatRelativeTime(point.timestamp, latestTimestamp),
        fps: Math.round(point.outboundFps > 0 ? point.outboundFps : point.inboundFps),
      }));
    }
    if (currentFps > 0) {
      return [{ timeLabel: 'Now', fps: currentFps }];
    }
    return [];
  }, [currentFps, latestTimestamp, slicedHistory]);

  const fpsJitter = computeFpsJitter(fpsChartData.map((item) => item.fps));
  const smoothness = getSmoothnessRating(
    currentFps,
    fps,
    fpsJitter,
    systemMetrics.droppedFrames
  );
  const frameTimeMs = currentFps > 0 ? (1000 / currentFps).toFixed(1) : '--';

  const rttSparkData = useMemo(() => {
    if (slicedHistory.length > 0) {
      return slicedHistory.map((point) => ({
        value: Math.round(point.rttMs),
        label: formatRelativeTime(point.timestamp, latestTimestamp),
      }));
    }
    if (systemMetrics.rttMs > 0) {
      return [{ value: Math.round(systemMetrics.rttMs), label: 'Now' }];
    }
    return [];
  }, [latestTimestamp, slicedHistory, systemMetrics.rttMs]);

  const rttValue = Math.round(systemMetrics.rttMs);
  const rttColor = rttValue > 110 ? '#ff5f56' : rttValue > 45 ? '#e3c54e' : '#7bd0ff';
  const rttBadgeClass =
    rttValue <= 0
      ? styles.statusStandby
      : rttValue < 45
        ? styles.statusGood
        : rttValue < 110
          ? styles.statusWarn
          : styles.statusError;

  const cpuPct = Math.max(0, Math.min(100, Math.round(systemMetrics.cpuUsagePercent)));
  const ramUsedGb = (systemMetrics.memoryUsedMb / 1024).toFixed(1);
  const ramTotalGb = (systemMetrics.memoryTotalMb / 1024).toFixed(1);
  const ramPct =
    systemMetrics.memoryTotalMb > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((systemMetrics.memoryUsedMb / systemMetrics.memoryTotalMb) * 100))
        )
      : 0;

  const encoderSummary =
    systemMetrics.isHardwareAccelerated === true
      ? `HW Encoder${systemMetrics.activeCodec ? ` · ${systemMetrics.activeCodec}` : ''}`
      : systemMetrics.isHardwareAccelerated === false
        ? `SW Fallback${systemMetrics.activeCodec ? ` · ${systemMetrics.activeCodec}` : ''}`
        : `Auto Encoder${systemMetrics.activeCodec ? ` · ${systemMetrics.activeCodec}` : ''}`;

  const healthPct = computeChannelHealthPercent(isConnected, systemMetrics);
  const isAudioSynchronized =
    isConnected &&
    (systemMetrics.audioBitrateKbps > 0 ||
      systemMetrics.audioJitterBufferMs > 0 ||
      hasActiveAudioStreams);

  const audioBufferMs = Math.round(systemMetrics.audioJitterBufferMs);
  const audioHealthPct = isAudioSynchronized
    ? Math.max(15, Math.min(100, Math.round(100 - Math.min(80, audioBufferMs * 0.7))))
    : 0;

  return (
    <div className={styles.panelRoot} data-testid="telemetry-panel">
      {/* Time Window Selector */}
      <div className={styles.windowBar}>
        <span className={styles.windowLabel}>Analysis Window</span>
        <div className={styles.segmentedGroup} role="tablist" aria-label="Telemetry time window">
          {WINDOW_KEYS.map((key) => (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={selectedWindow === key}
              data-testid={`telemetry-window-${key}`}
              className={`${styles.windowBtn} ${selectedWindow === key ? styles.windowBtnActive : ''}`}
              onClick={() => setSelectedWindow(key)}
            >
              {key}
            </button>
          ))}
        </div>
      </div>

      {/* Bitrate & Throughput */}
      <section className={styles.card} data-testid="telemetry-bitrate-chart">
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--primary)' }}>
              area_chart
            </span>
            <span className={styles.cardTitle}>Bitrate &amp; Throughput</span>
          </div>
          <span className={styles.primaryMetric}>
            {currentBitrateKbps.toLocaleString()}
            <span className={styles.metricUnit}>kbps</span>
          </span>
        </div>

        <div className={styles.chartWrap}>
          <BitrateAreaChart
            data={bitrateChartData}
            accentColor="#ff4d6d"
            height={108}
            startLabel={windowMeta.startLabel}
            midLabel={windowMeta.midLabel}
            endLabel="Now"
          />
        </div>

        <div className={styles.cardFooter}>
          <span className={styles.codecBadge}>
            Codec: {systemMetrics.activeCodec || 'Auto'} ({formatEncoderLabel(systemMetrics)})
          </span>
          <div className={styles.footerStatsGroup}>
            <span>Peak: {peakBitrate.toLocaleString()} kbps</span>
            <span>Min: {minBitrate.toLocaleString()} kbps</span>
          </div>
        </div>
      </section>

      {/* FPS Stability */}
      <section className={styles.card} data-testid="telemetry-fps-chart">
        <div className={styles.cardHeader}>
          <div className={styles.cardTitleGroup}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--secondary)' }}>
              speed
            </span>
            <span className={styles.cardTitle}>FPS Stability</span>
          </div>
          <div className={styles.footerStatsGroup}>
            <span className={`${styles.statusPill} ${smoothness.className}`}>
              {smoothness.label}
            </span>
            <span className={styles.primaryMetric}>
              {currentFps}
              <span className={styles.metricUnit}>FPS</span>
            </span>
          </div>
        </div>

        <div className={styles.chartWrap}>
          <FpsLineChart
            data={fpsChartData}
            targetFps={fps}
            accentColor="#7bd0ff"
            height={100}
            startLabel={windowMeta.startLabel}
            midLabel={windowMeta.midLabel}
            endLabel="Now"
          />
        </div>

        <div className={styles.cardFooter}>
          <span>Dropped: {systemMetrics.droppedFrames}</span>
          <span>Frame: {frameTimeMs} ms</span>
          <span>Target: {fps} FPS</span>
          <span>Jitter: ±{fpsJitter} fps</span>
        </div>
      </section>

      {/* 2-col row: RTT Latency + Host Hardware */}
      <div className={styles.twoColGrid}>
        <section className={styles.compactCard} data-testid="telemetry-rtt-chart">
          <div className={styles.compactHeader}>
            <span className={styles.compactTitle}>RTT Latency</span>
            <span className={`${styles.statusPill} ${rttBadgeClass}`}>
              {rttValue > 0 ? `${rttValue}ms` : '--ms'}
            </span>
          </div>

          <SparklineChart
            data={rttSparkData}
            color={rttColor}
            height={44}
            unit="ms"
            ariaLabel="RTT latency sparkline"
          />

          <div className={styles.compactFooter}>
            <span>Loss: {systemMetrics.packetLossPercent.toFixed(1)}%</span>
            <span>Jitter: {Math.round(systemMetrics.jitterMs)}ms</span>
          </div>
        </section>

        <section className={styles.compactCard}>
          <div className={styles.compactHeader}>
            <span className={styles.compactTitle}>Host Hardware</span>
            <span
              className={`${styles.statusPill} ${
                systemMetrics.highLoadWarning ? styles.statusError : styles.statusGood
              }`}
            >
              {systemMetrics.highLoadWarning ? 'High Load' : 'Normal'}
            </span>
          </div>

          <div className={styles.meterBlock}>
            <div className={styles.meterLabelRow}>
              <span>CPU ({systemMetrics.cpuCores || 0}T)</span>
              <span>{cpuPct}%</span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${
                  cpuPct >= 80 ? styles.progressWarn : styles.progressPrimary
                }`}
                style={{ width: `${cpuPct}%` }}
              />
            </div>
          </div>

          <div className={styles.meterBlock}>
            <div className={styles.meterLabelRow}>
              <span>RAM</span>
              <span>
                {ramUsedGb} / {ramTotalGb} GB
              </span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${
                  ramPct >= 85 ? styles.progressWarn : styles.progressSecondary
                }`}
                style={{ width: `${ramPct}%` }}
              />
            </div>
          </div>

          <div className={styles.encoderLine} title={encoderSummary}>
            {encoderSummary}
          </div>
        </section>
      </div>

      {/* WebRTC DataChannel */}
      <section className={styles.securityCard}>
        <div className={styles.securityLeft}>
          <div className={styles.shieldIconWrap}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              verified_user
            </span>
          </div>
          <div className={styles.securityMeta}>
            <span className={styles.securityTitle}>WebRTC DataChannel</span>
            <span className={styles.securitySubtitle}>E2EE Encrypted · SRTP/DTLS</span>
          </div>
        </div>
        <span
          className={`${styles.statusPill} ${
            healthPct >= 80 ? styles.statusGood : healthPct > 0 ? styles.statusWarn : styles.statusError
          }`}
        >
          {healthPct}% OK
        </span>
      </section>

      {/* Audio Buffer & Flow */}
      <section className={styles.card}>
        <div className={styles.audioHeaderRow}>
          <div className={styles.cardTitleGroup}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--tertiary)' }}>
              graphic_eq
            </span>
            <span className={styles.cardTitle}>Audio Buffer &amp; Flow</span>
          </div>
          <span
            className={`${styles.statusPill} ${
              isAudioSynchronized ? styles.statusGood : styles.statusStandby
            }`}
          >
            {isAudioSynchronized ? 'SYNCHRONIZED' : 'STANDBY'}
          </span>
        </div>

        <div className={styles.audioSpecRow}>
          <span className={styles.audioCodecName}>{systemMetrics.audioCodec || 'Opus'} Stereo</span>
          <span className={styles.audioRateMono}>
            48kHz · {Math.round(systemMetrics.audioBitrateKbps)} kbps
          </span>
        </div>

        <div className={styles.meterBlock}>
          <div className={styles.meterLabelRow}>
            <span>Jitter Buffer Health</span>
            <span>
              {audioBufferMs}ms · {systemMetrics.audioPacketsLost} pkt lost
            </span>
          </div>
          <div className={styles.progressTrack}>
            <div
              className={`${styles.progressFill} ${
                audioHealthPct >= 70
                  ? styles.progressGood
                  : audioHealthPct >= 40
                    ? styles.progressSecondary
                    : styles.progressWarn
              }`}
              style={{ width: `${audioHealthPct}%` }}
            />
          </div>
        </div>
      </section>
    </div>
  );
};
