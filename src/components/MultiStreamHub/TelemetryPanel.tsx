import React, { useMemo, useState } from 'react';
import styles from './TelemetryPanel.module.css';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { EMPTY_AUDIO_TELEMETRY } from '../../domain/config';
import {
  AudioTelemetryDto,
  PeerTelemetryDto,
  PeerTelemetryHistoryPointDto,
  RoomPeerDto,
  StreamFpsOption,
  StreamItem,
  StreamQualityLimitationReason,
  StreamResolutionPreset,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
} from '../../domain/dtos';
import { formatResolutionLabel } from '../../hooks/room/roomHelpers';
import { BitrateAreaChart, FpsLineChart, SparklineChart } from './TelemetryCharts';

export type TelemetryWindowKey = '1m' | '5m' | '15m';

export interface TelemetryPanelProps {
  peer: RoomPeerDto;
  isLocal: boolean;
  peerStream?: StreamItem;
  localFpsSetting: StreamFpsOption;
  localResolutionSetting: StreamResolutionPreset;
  isConnected: boolean;
  systemMetrics: SystemMetricsDto;
  localHistory: TelemetryHistoryPointDto[];
  peerHistory: PeerTelemetryHistoryPointDto[];
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

const sliceHistoryByWindow = <T extends { timestamp: number }>(
  history: T[],
  windowKey: TelemetryWindowKey
): T[] => {
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

const computeFpsDeltaAvg = (fpsValues: number[]): number => {
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
  fpsDelta: number,
  droppedFrames: number
): { label: 'High Smoothness' | 'Moderate' | 'Low' | 'Standby'; className: string } => {
  if (currentFps <= 0) {
    return { label: 'Standby', className: styles.statusStandby };
  }

  const ratio = targetFps > 0 ? currentFps / targetFps : 1;
  if (ratio >= 0.85 && fpsDelta <= 3 && droppedFrames < 15) {
    return { label: 'High Smoothness', className: styles.statusGood };
  }
  if (ratio >= 0.55 && fpsDelta <= 8) {
    return { label: 'Moderate', className: styles.statusWarn };
  }
  return { label: 'Low', className: styles.statusError };
};

const formatCodecAccelLabel = (accel: boolean | null, implementation: string): string => {
  if (implementation) return implementation;
  if (accel === true) return 'HW';
  if (accel === false) return 'SW';
  return 'Auto';
};

const formatLimitationLabel = (reason: StreamQualityLimitationReason): string => {
  if (reason === 'cpu') return 'CPU';
  if (reason === 'bandwidth') return 'Bandwidth';
  if (reason === 'other') return 'Other';
  return 'None';
};

const formatChannelLabel = (channels: number): string => {
  if (channels === 1) return ' Mono';
  if (channels === 2) return ' Stereo';
  if (channels > 2) return ` ${channels}ch`;
  return '';
};

const formatSampleRateLabel = (sampleRateHz: number): string => {
  if (sampleRateHz <= 0) return '';
  const khz = Math.round((sampleRateHz / 1000) * 10) / 10;
  return `${khz} kHz · `;
};

const resolveTransportStatus = (
  isConnected: boolean,
  isLocal: boolean,
  systemMetrics: SystemMetricsDto,
  peerStats: PeerTelemetryDto | undefined
): { subtitle: string; badgeText: string; badgeClass: string } => {
  if (!isConnected) {
    return {
      subtitle: 'Signaling disconnected · No DTLS transport',
      badgeText: 'OFFLINE',
      badgeClass: styles.statusError,
    };
  }

  if (!isLocal) {
    const pcState = peerStats?.connectionState ?? 'unknown';
    const dcState = peerStats?.dataChannelState ?? 'closed';
    const dtls = peerStats?.dtlsState || (pcState === 'connected' ? 'connected' : pcState);
    const healthy = pcState === 'connected' && dcState === 'open';
    const connecting = pcState === 'connecting' || pcState === 'new' || dcState === 'connecting';
    return {
      subtitle: `DTLS-SRTP (${dtls}) · PC ${pcState} · DC ${dcState}`,
      badgeText: healthy ? '100% OK' : connecting ? 'CONNECTING' : 'DEGRADED',
      badgeClass: healthy ? styles.statusGood : connecting ? styles.statusWarn : styles.statusError,
    };
  }

  const peerEntries = Object.values(systemMetrics.peerStats ?? {});
  if (peerEntries.length === 0) {
    return {
      subtitle: 'DTLS-SRTP ready · Waiting for remote peers',
      badgeText: 'STANDBY',
      badgeClass: styles.statusStandby,
    };
  }

  const healthyCount = peerEntries.filter(
    (entry) => entry.connectionState === 'connected' && entry.dataChannelState === 'open'
  ).length;
  const healthPct = Math.round((healthyCount / peerEntries.length) * 100);
  return {
    subtitle: `DTLS-SRTP · ${healthyCount}/${peerEntries.length} peers connected`,
    badgeText: `${healthPct}% OK`,
    badgeClass:
      healthPct >= 80 ? styles.statusGood : healthPct > 0 ? styles.statusWarn : styles.statusError,
  };
};

const resolveAudioCardView = (audio: AudioTelemetryDto, isLocal: boolean) => {
  if (!audio.hasAudio) {
    return {
      isActive: false,
      badgeText: 'NO AUDIO',
      badgeClass: styles.statusStandby,
      barPct: 0,
    };
  }

  if (isLocal) {
    const transmitting = audio.bitrateKbps > 0;
    const levelPct =
      audio.audioLevel !== null
        ? Math.max(12, Math.min(100, Math.round(audio.audioLevel * 100)))
        : transmitting
          ? 100
          : 30;
    return {
      isActive: true,
      badgeText: transmitting ? 'TRANSMITTING' : 'CAPTURING',
      badgeClass: styles.statusGood,
      barPct: levelPct,
    };
  }

  const synchronized = audio.bitrateKbps > 0 || audio.jitterBufferMs > 0;
  const bufferHealthPct = synchronized
    ? Math.max(15, Math.min(100, Math.round(100 - Math.min(80, audio.jitterBufferMs * 0.7))))
    : 25;
  return {
    isActive: true,
    badgeText: synchronized ? 'SYNCHRONIZED' : 'ACTIVE',
    badgeClass: styles.statusGood,
    barPct: bufferHealthPct,
  };
};

export const TelemetryPanel: React.FC<TelemetryPanelProps> = ({
  peer,
  isLocal,
  peerStream,
  localFpsSetting,
  localResolutionSetting,
  isConnected,
  systemMetrics,
  localHistory,
  peerHistory,
}) => {
  const [selectedWindow, setSelectedWindow] = useState<TelemetryWindowKey>('1m');

  const peerStats = isLocal ? undefined : systemMetrics.peerStats?.[peer.peerIdSafe];
  const remoteViewerCount = Object.keys(systemMetrics.peerStats ?? {}).length;

  const slicedLocal = useMemo(
    () => sliceHistoryByWindow(localHistory, selectedWindow),
    [localHistory, selectedWindow]
  );
  const slicedPeer = useMemo(
    () => sliceHistoryByWindow(peerHistory, selectedWindow),
    [peerHistory, selectedWindow]
  );

  const windowMeta = WINDOW_CONFIG[selectedWindow];
  const activeTimestamps = isLocal ? slicedLocal : slicedPeer;
  const latestTimestamp =
    activeTimestamps.length > 0 ? activeTimestamps[activeTimestamps.length - 1].timestamp : Date.now();

  const currentBitrateKbps = Math.round(
    isLocal ? systemMetrics.outboundBitrateKbps : (peerStats?.inboundBitrateKbps ?? 0)
  );

  const bitrateChartData = useMemo(() => {
    const points = isLocal
      ? slicedLocal.map((point) => ({
          timeLabel: formatRelativeTime(point.timestamp, latestTimestamp),
          value: Math.round(point.bitrateKbps),
        }))
      : slicedPeer.map((point) => ({
          timeLabel: formatRelativeTime(point.timestamp, latestTimestamp),
          value: Math.round(point.inboundBitrateKbps),
        }));

    if (points.length === 0 && currentBitrateKbps > 0) {
      return [{ timeLabel: 'Now', value: currentBitrateKbps }];
    }
    return points;
  }, [currentBitrateKbps, isLocal, latestTimestamp, slicedLocal, slicedPeer]);

  const bitrateValues = bitrateChartData.map((item) => item.value);
  const peakBitrate = bitrateValues.length > 0 ? Math.max(...bitrateValues) : currentBitrateKbps;
  const nonZeroBitrates = bitrateValues.filter((val) => val > 0);
  const minBitrate =
    nonZeroBitrates.length > 0 ? Math.min(...nonZeroBitrates) : currentBitrateKbps;

  const currentFps = Math.round(
    isLocal
      ? systemMetrics.outboundFps > 0
        ? systemMetrics.outboundFps
        : systemMetrics.localCaptureFps
      : (peerStats?.inboundFps ?? 0)
  );
  const targetFps = isLocal
    ? localFpsSetting
    : (peerStream?.fps ?? (currentFps > 0 ? currentFps : 60));

  const fpsChartData = useMemo(() => {
    const points = isLocal
      ? slicedLocal.map((point) => ({
          timeLabel: formatRelativeTime(point.timestamp, latestTimestamp),
          fps: Math.round(point.outboundFps),
        }))
      : slicedPeer.map((point) => ({
          timeLabel: formatRelativeTime(point.timestamp, latestTimestamp),
          fps: Math.round(point.inboundFps),
        }));

    if (points.length === 0 && currentFps > 0) {
      return [{ timeLabel: 'Now', fps: currentFps }];
    }
    return points;
  }, [currentFps, isLocal, latestTimestamp, slicedLocal, slicedPeer]);

  const fpsDelta = computeFpsDeltaAvg(fpsChartData.map((item) => item.fps));
  const droppedFrames = isLocal ? 0 : (peerStats?.inboundDroppedFrames ?? 0);
  const smoothness = getSmoothnessRating(currentFps, targetFps, fpsDelta, droppedFrames);
  const frameTimeMs = currentFps > 0 ? (1000 / currentFps).toFixed(1) : '--';

  const rttValue = Math.round(isLocal ? systemMetrics.rttMs : (peerStats?.rttMs ?? 0));
  const rttLossPct = isLocal ? systemMetrics.packetLossPercent : (peerStats?.packetLossPercent ?? 0);
  const rttJitterMs = Math.round(isLocal ? systemMetrics.jitterMs : (peerStats?.jitterMs ?? 0));

  const rttSparkData = useMemo(() => {
    const points = isLocal
      ? slicedLocal.map((point) => ({
          value: Math.round(point.rttMs),
          label: formatRelativeTime(point.timestamp, latestTimestamp),
        }))
      : slicedPeer.map((point) => ({
          value: Math.round(point.rttMs),
          label: formatRelativeTime(point.timestamp, latestTimestamp),
        }));

    if (points.length === 0 && rttValue > 0) {
      return [{ value: rttValue, label: 'Now' }];
    }
    return points;
  }, [isLocal, latestTimestamp, rttValue, slicedLocal, slicedPeer]);

  const rttColor = rttValue > 110 ? '#ff5f56' : rttValue > 45 ? '#e3c54e' : '#7bd0ff';
  const rttBadgeClass =
    rttValue <= 0
      ? styles.statusStandby
      : rttValue < 45
        ? styles.statusGood
        : rttValue < 110
          ? styles.statusWarn
          : styles.statusError;

  const videoCodec = isLocal ? systemMetrics.activeCodec : (peerStats?.inboundCodec ?? '');
  const videoAccel = isLocal
    ? systemMetrics.isHardwareAccelerated
    : (peerStats?.isDecoderHardwareAccelerated ?? null);
  const videoImpl = isLocal
    ? systemMetrics.encoderImplementation
    : (peerStats?.decoderImplementation ?? '');
  const pipelineRole = isLocal ? 'Encoder' : 'Decoder';
  const pipelineSummary =
    videoAccel === true
      ? `HW ${pipelineRole}${videoCodec ? ` · ${videoCodec}` : ''}`
      : videoAccel === false
        ? `SW ${pipelineRole}${videoCodec ? ` · ${videoCodec}` : ''}`
        : `Auto ${pipelineRole}${videoCodec ? ` · ${videoCodec}` : ''}`;

  const streamWidth = isLocal ? systemMetrics.localWidth : (peerStats?.inboundWidth ?? 0);
  const streamHeight = isLocal ? systemMetrics.localHeight : (peerStats?.inboundHeight ?? 0);
  const resolutionSummary =
    streamWidth > 0 && streamHeight > 0
      ? `${streamWidth}×${streamHeight}`
      : isLocal
        ? formatResolutionLabel(localResolutionSetting)
        : peerStream?.resolution || 'Live';

  const cpuPct = Math.max(0, Math.min(100, Math.round(systemMetrics.cpuUsagePercent)));
  const cpuLabel =
    systemMetrics.cpuSource === 'system'
      ? `OS CPU (${systemMetrics.cpuCores || 0}T)`
      : systemMetrics.cpuSource === 'event-loop'
        ? `UI Thread (${systemMetrics.cpuCores || 0}T)`
        : 'CPU';

  const ramTotalGb = (systemMetrics.memoryTotalMb / 1024).toFixed(1);
  const ramUsedGb = (systemMetrics.memoryUsedMb / 1024).toFixed(1);
  const ramPct =
    systemMetrics.memoryTotalMb > 0
      ? Math.max(
          0,
          Math.min(100, Math.round((systemMetrics.memoryUsedMb / systemMetrics.memoryTotalMb) * 100))
        )
      : 0;
  const memLabel =
    systemMetrics.memorySource === 'system'
      ? 'System RAM'
      : systemMetrics.memorySource === 'js-heap'
        ? 'JS Heap'
        : 'Memory';
  const memValueText =
    systemMetrics.memorySource === 'system'
      ? `${ramUsedGb} / ${ramTotalGb} GB`
      : systemMetrics.memorySource === 'js-heap'
        ? `${systemMetrics.memoryUsedMb} MB / ${ramTotalGb} GB`
        : 'N/A';

  const transportStatus = resolveTransportStatus(isConnected, isLocal, systemMetrics, peerStats);
  const audio: AudioTelemetryDto = isLocal
    ? systemMetrics.localAudio
    : (peerStats?.inboundAudio ?? EMPTY_AUDIO_TELEMETRY);
  const audioView = resolveAudioCardView(audio, isLocal);

  return (
    <div className={styles.panelRoot} data-testid="telemetry-panel">
      {/* Inspected User Stream Identity */}
      <div className={styles.userHeaderCard} data-testid="telemetry-user-header">
        <div className={styles.userIdentity}>
          <img
            src={peer.avatarUrl || ELFY_MASCOT_ICON}
            alt={peer.displayName}
            className={styles.userAvatar}
          />
          <div className={styles.userTextBlock}>
            <div className={styles.userNameRow}>
              <span className={styles.userName} title={peer.displayName}>
                {peer.displayName}
              </span>
              <span className={styles.streamDirectionTag}>
                {isLocal ? 'OUTBOUND' : 'INBOUND'}
              </span>
            </div>
            <span className={styles.userSubMeta}>
              {resolutionSummary} · {currentFps > 0 ? `${currentFps} FPS` : `${targetFps} FPS target`}
            </span>
          </div>
        </div>
        <span className={`${styles.statusPill} ${styles.statusGood}`}>LIVE</span>
      </div>

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
            Codec: {videoCodec || 'Auto'} ({formatCodecAccelLabel(videoAccel, videoImpl)})
          </span>
          <div className={styles.footerStatsGroup}>
            {isLocal && remoteViewerCount === 0 ? (
              <span>0 viewers connected</span>
            ) : (
              <>
                <span>Peak: {peakBitrate.toLocaleString()} kbps</span>
                <span>Min: {minBitrate.toLocaleString()} kbps</span>
              </>
            )}
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
            targetFps={targetFps}
            accentColor="#7bd0ff"
            height={100}
            startLabel={windowMeta.startLabel}
            midLabel={windowMeta.midLabel}
            endLabel="Now"
          />
        </div>

        <div className={styles.cardFooter}>
          {isLocal ? (
            <span>Limit: {formatLimitationLabel(systemMetrics.qualityLimitationReason)}</span>
          ) : (
            <span>Dropped: {droppedFrames}</span>
          )}
          <span>Frame: {frameTimeMs} ms</span>
          <span>Target: {targetFps} FPS</span>
          <span>Avg Δ: ±{fpsDelta} fps</span>
        </div>
      </section>

      {/* 2-col row: RTT Latency + Local Device Load */}
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
            <span>Loss: {rttLossPct.toFixed(1)}%</span>
            <span>Jitter: {rttJitterMs}ms</span>
          </div>
        </section>

        <section className={styles.compactCard} data-testid="telemetry-device-card">
          <div className={styles.compactHeader}>
            <span className={styles.compactTitle}>
              {isLocal ? 'Host Device (You)' : 'Local Device'}
            </span>
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
              <span>{cpuLabel}</span>
              <span>{systemMetrics.cpuSource === 'unavailable' ? 'N/A' : `${cpuPct}%`}</span>
            </div>
            <div className={styles.progressTrack}>
              <div
                className={`${styles.progressFill} ${
                  cpuPct >= 80 ? styles.progressWarn : styles.progressPrimary
                }`}
                style={{ width: `${systemMetrics.cpuSource === 'unavailable' ? 0 : cpuPct}%` }}
              />
            </div>
          </div>

          <div className={styles.meterBlock}>
            <div className={styles.meterLabelRow}>
              <span>{memLabel}</span>
              <span>{memValueText}</span>
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

          <div className={styles.encoderLine} title={pipelineSummary}>
            {pipelineSummary}
          </div>
        </section>
      </div>

      {/* WebRTC Transport */}
      <section className={styles.securityCard} data-testid="telemetry-transport-card">
        <div className={styles.securityLeft}>
          <div className={styles.shieldIconWrap}>
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              verified_user
            </span>
          </div>
          <div className={styles.securityMeta}>
            <span className={styles.securityTitle}>WebRTC P2P Transport</span>
            <span className={styles.securitySubtitle}>{transportStatus.subtitle}</span>
          </div>
        </div>
        <span className={`${styles.statusPill} ${transportStatus.badgeClass}`}>
          {transportStatus.badgeText}
        </span>
      </section>

      {/* Audio Buffer & Flow (Strictly Real Track & WebRTC Audio Stats) */}
      <section className={styles.card} data-testid="telemetry-audio-card">
        <div className={styles.audioHeaderRow}>
          <div className={styles.cardTitleGroup}>
            <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--tertiary)' }}>
              graphic_eq
            </span>
            <span className={styles.cardTitle}>
              {isLocal ? 'Outbound Audio Flow' : 'Audio Buffer & Flow'}
            </span>
          </div>
          <span className={`${styles.statusPill} ${audioView.badgeClass}`}>
            {audioView.badgeText}
          </span>
        </div>

        {!audio.hasAudio ? (
          <>
            <div className={styles.audioSpecRow}>
              <span className={styles.audioCodecName}>Video Only Stream</span>
              <span className={styles.audioRateMono}>0 audio tracks</span>
            </div>
            <div className={styles.audioMutedNote}>
              No active audio track or audio RTP stream detected.
            </div>
          </>
        ) : (
          <>
            <div className={styles.audioSpecRow}>
              <span className={styles.audioCodecName}>
                {audio.codec || 'Audio'}
                {formatChannelLabel(audio.channels)}
              </span>
              <span className={styles.audioRateMono}>
                {formatSampleRateLabel(audio.sampleRateHz)}
                {audio.bitrateKbps} kbps
              </span>
            </div>

            <div className={styles.meterBlock}>
              <div className={styles.meterLabelRow}>
                <span>{isLocal ? 'Outbound Audio RTP' : 'Jitter Buffer'}</span>
                <span>
                  {isLocal
                    ? `jitter ${audio.jitterMs}ms · ${audio.packetsLost} pkt lost`
                    : `${audio.jitterBufferMs}ms · ${audio.packetsLost} pkt lost`}
                </span>
              </div>
              <div className={styles.progressTrack}>
                <div
                  className={`${styles.progressFill} ${
                    audioView.barPct >= 70
                      ? styles.progressGood
                      : audioView.barPct >= 40
                        ? styles.progressSecondary
                        : styles.progressWarn
                  }`}
                  style={{ width: `${audioView.barPct}%` }}
                />
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
};
