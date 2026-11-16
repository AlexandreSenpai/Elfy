import React, { useRef } from 'react';
import styles from './ParticipantsPanel.module.css';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import {
  PeerTelemetryDto,
  PeerTelemetryHistoryPointDto,
  RoomPeerDto,
  RoomRole,
  StreamFpsOption,
  StreamItem,
  StreamResolutionPreset,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
} from '../../domain/dtos';
import { formatResolutionLabel } from '../../hooks/room/roomHelpers';
import { SparklineChart, SparklinePoint } from './TelemetryCharts';
import { getVolumeIcon } from './StreamTile';

export interface ParticipantsPanelProps {
  localPeerIdSafe: string;
  localRole: RoomRole;
  isSharing: boolean;
  peers: RoomPeerDto[];
  streams: StreamItem[];
  streamVolumes: Record<string, number>;
  isDeafened: boolean;
  fps: StreamFpsOption;
  resolution: StreamResolutionPreset;
  systemMetrics: SystemMetricsDto;
  telemetryHistory: TelemetryHistoryPointDto[];
  peerTelemetryHistory: Record<string, PeerTelemetryHistoryPointDto[]>;
  onSetStreamVolume: (peerIdSafe: string, volume: number) => void;
  onKickPeer: (peerIdSafe: string, reason?: string) => void | Promise<void>;
  onInspectPeerTelemetry: (peerIdSafe: string) => void;
}

export const isPeerActivelyStreaming = (
  peer: RoomPeerDto,
  localPeerIdSafe: string,
  isSharing: boolean,
  streams: StreamItem[]
): boolean => {
  if (peer.peerIdSafe === localPeerIdSafe) {
    return isSharing || peer.isStreaming;
  }
  return peer.isStreaming || streams.some((stream) => stream.peerIdSafe === peer.peerIdSafe);
};

const getLatencyTierClass = (rttMs: number): string => {
  if (rttMs <= 0) return '';
  if (rttMs < 45) return styles.latencyGood;
  if (rttMs < 110) return styles.latencyWarn;
  return styles.latencyHigh;
};

const formatSampleTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  return date.toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
};

const buildLocalSparkline = (
  isLive: boolean,
  telemetryHistory: TelemetryHistoryPointDto[],
  systemMetrics: SystemMetricsDto
): { points: SparklinePoint[]; color: string; unit: string } => {
  if (!isLive) {
    return { points: [], color: '#7bd0ff', unit: '' };
  }
  const recent = telemetryHistory.slice(-30);
  const points = recent.map((point) => ({
    value: Math.round(point.bitrateKbps),
    label: formatSampleTime(point.timestamp),
  }));
  if (points.length === 0 && systemMetrics.outboundBitrateKbps > 0) {
    points.push({ value: Math.round(systemMetrics.outboundBitrateKbps), label: 'Now' });
  }
  return { points, color: '#ff4d6d', unit: 'kbps' };
};

const buildRemotePeerSparkline = (
  isLive: boolean,
  history: PeerTelemetryHistoryPointDto[] | undefined,
  liveStats: PeerTelemetryDto | undefined
): { points: SparklinePoint[]; color: string; unit: string } => {
  const samples = (history ?? []).slice(-30);

  if (isLive) {
    const hasInboundBitrate =
      samples.some((point) => point.inboundBitrateKbps > 0) ||
      (liveStats?.inboundBitrateKbps ?? 0) > 0;
    if (hasInboundBitrate) {
      const points = samples.map((point) => ({
        value: Math.round(point.inboundBitrateKbps),
        label: formatSampleTime(point.timestamp),
      }));
      if (points.length === 0 && liveStats) {
        points.push({ value: Math.round(liveStats.inboundBitrateKbps), label: 'Now' });
      }
      return { points, color: '#ff4d6d', unit: 'kbps' };
    }
  }

  const rttPoints = samples
    .filter((point) => point.rttMs > 0)
    .map((point) => ({
      value: Math.round(point.rttMs),
      label: formatSampleTime(point.timestamp),
    }));
  if (rttPoints.length === 0 && liveStats && liveStats.rttMs > 0) {
    rttPoints.push({ value: Math.round(liveStats.rttMs), label: 'Now' });
  }
  return { points: rttPoints, color: '#7bd0ff', unit: 'ms' };
};

const resolveQualityText = (
  isLive: boolean,
  isLocal: boolean,
  peerStream: StreamItem | undefined,
  liveStats: PeerTelemetryDto | undefined,
  systemMetrics: SystemMetricsDto,
  hasAnyActiveStream: boolean,
  localResolution: StreamResolutionPreset,
  localFps: StreamFpsOption
): { label: string; isLive: boolean } => {
  if (isLive && isLocal) {
    const activeFps =
      systemMetrics.outboundFps > 0
        ? systemMetrics.outboundFps
        : systemMetrics.localCaptureFps || localFps;
    const resLabel =
      systemMetrics.localHeight > 0
        ? `${systemMetrics.localHeight}p`
        : formatResolutionLabel(localResolution);
    return { label: `${resLabel} ${activeFps}fps`, isLive: true };
  }

  if (isLive && !isLocal) {
    if (liveStats && liveStats.inboundHeight > 0 && liveStats.inboundFps > 0) {
      return { label: `${liveStats.inboundHeight}p ${liveStats.inboundFps}fps`, isLive: true };
    }
    if (peerStream) {
      return { label: `${peerStream.resolution} ${peerStream.fps}fps`, isLive: true };
    }
    return { label: 'Live Stream', isLive: true };
  }

  if (hasAnyActiveStream) {
    return { label: 'Watching', isLive: false };
  }
  return { label: 'Idle', isLive: false };
};

export const ParticipantsPanel: React.FC<ParticipantsPanelProps> = ({
  localPeerIdSafe,
  localRole,
  isSharing,
  peers,
  streams,
  streamVolumes,
  isDeafened,
  fps,
  resolution,
  systemMetrics,
  telemetryHistory,
  peerTelemetryHistory,
  onSetStreamVolume,
  onKickPeer,
  onInspectPeerTelemetry,
}) => {
  const lastNonZeroVolumeRef = useRef<Map<string, number>>(new Map());

  const handleTogglePeerMute = (peerIdSafe: string, currentVolume: number): void => {
    if (currentVolume > 0) {
      lastNonZeroVolumeRef.current.set(peerIdSafe, currentVolume);
      onSetStreamVolume(peerIdSafe, 0);
      return;
    }
    const restored = lastNonZeroVolumeRef.current.get(peerIdSafe) ?? 100;
    onSetStreamVolume(peerIdSafe, restored > 0 ? restored : 100);
  };

  const hasAnyActiveStream =
    isSharing || streams.length > 0 || peers.some((peer) => peer.isStreaming);
  const remoteStatsCount = Object.keys(systemMetrics.peerStats ?? {}).length;

  return (
    <div className={styles.panelRoot} data-testid="participants-panel">
      <div className={styles.subHeader}>
        <span className={styles.activeCount}>
          <span className={styles.activeDot} />
          <span>{peers.length} Active in Room</span>
        </span>
        <span className={styles.meshLabel}>WebRTC P2P Mesh</span>
      </div>

      <div className={styles.peerList}>
        {peers.length === 0 ? (
          <div className={styles.emptyState}>Waiting for room participants...</div>
        ) : (
          peers.map((peer) => {
            const isLocal = peer.peerIdSafe === localPeerIdSafe;
            const isOwner = peer.role === 'owner';
            const peerStream = streams.find((stream) => stream.peerIdSafe === peer.peerIdSafe);
            const isLive = isPeerActivelyStreaming(peer, localPeerIdSafe, isSharing, streams);

            const liveStats = systemMetrics.peerStats?.[peer.peerIdSafe];
            const history = peerTelemetryHistory[peer.peerIdSafe];
            const latestHistory =
              history && history.length > 0 ? history[history.length - 1] : undefined;

            const rttMs = isLocal ? 0 : liveStats?.rttMs ?? latestHistory?.rttMs ?? 0;
            const lossPct = isLocal
              ? remoteStatsCount > 0
                ? systemMetrics.packetLossPercent
                : 0
              : liveStats?.packetLossPercent ?? latestHistory?.packetLossPercent ?? 0;

            const rawSavedVolume = streamVolumes[peer.peerIdSafe] ?? peerStream?.volume ?? 100;
            const effectiveVolume = isDeafened ? 0 : rawSavedVolume;
            const isEffectivelyMuted = effectiveVolume === 0;

            if (rawSavedVolume > 0) {
              lastNonZeroVolumeRef.current.set(peer.peerIdSafe, rawSavedVolume);
            }

            const sparkline = isLocal
              ? buildLocalSparkline(isLive, telemetryHistory, systemMetrics)
              : buildRemotePeerSparkline(isLive, history, liveStats);

            const quality = resolveQualityText(
              isLive,
              isLocal,
              peerStream,
              liveStats,
              systemMetrics,
              hasAnyActiveStream,
              resolution,
              fps
            );

            const canKick = localRole === 'owner' && !isLocal;

            return (
              <div
                key={peer.peerIdSafe}
                className={styles.peerCard}
                data-testid="participant-card"
                data-peer-id={peer.peerIdSafe}
              >
                <div className={styles.peerTopRow}>
                  <div className={styles.peerIdentity}>
                    <div className={styles.avatarWrap}>
                      <img
                        src={peer.avatarUrl || ELFY_MASCOT_ICON}
                        alt={peer.displayName}
                        className={styles.avatarImg}
                      />
                      <span className={styles.onlineDot} />
                    </div>

                    <div className={styles.nameBlock}>
                      <div className={styles.nameLine}>
                        <span className={styles.displayName} title={peer.displayName}>
                          {peer.displayName}
                        </span>
                        {isOwner && (
                          <span className={`${styles.roleBadge} ${styles.roleHost}`}>HOST</span>
                        )}
                        {isLocal && (
                          <span className={`${styles.roleBadge} ${styles.roleYou}`}>YOU</span>
                        )}
                        {!isOwner && !isLocal && (
                          <span className={`${styles.roleBadge} ${styles.roleGuest}`}>GUEST</span>
                        )}
                        {isLive && (
                          <span className={styles.liveBadge}>
                            <span className={styles.liveDot} />
                            <span>LIVE</span>
                          </span>
                        )}
                      </div>

                      <span className={styles.peerTagText} title={peer.peerTag}>
                        {peer.peerTag}
                      </span>
                    </div>
                  </div>

                  <div className={styles.topRightActions}>
                    <span className={`${styles.latencyBadge} ${getLatencyTierClass(rttMs)}`}>
                      {isLocal ? 'Local' : rttMs > 0 ? `${Math.round(rttMs)}ms` : '--ms'}
                    </span>

                    <button
                      type="button"
                      className={styles.telemetryIconBtn}
                      data-testid="peer-telemetry-btn"
                      disabled={!isLive}
                      aria-label={
                        isLive
                          ? `View stream telemetry for ${peer.displayName}`
                          : `${peer.displayName} is not streaming`
                      }
                      title={
                        isLive
                          ? `View ${peer.displayName}'s stream telemetry`
                          : `${peer.displayName} is not currently streaming`
                      }
                      onClick={() => {
                        if (isLive) {
                          onInspectPeerTelemetry(peer.peerIdSafe);
                        }
                      }}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                        monitoring
                      </span>
                    </button>

                    {canKick && (
                      <button
                        type="button"
                        className={styles.kickBtn}
                        data-testid="kick-peer-btn"
                        aria-label={`Kick ${peer.displayName}`}
                        title="Kick user from room"
                        onClick={() => void onKickPeer(peer.peerIdSafe)}
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                          person_remove
                        </span>
                      </button>
                    )}
                  </div>
                </div>

                {isLocal ? (
                  <div className={styles.localAudioNotice}>
                    <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                      mic_off
                    </span>
                    <span>Local · No Echo</span>
                  </div>
                ) : (
                  <div className={styles.audioRow}>
                    <button
                      type="button"
                      className={`${styles.muteBtn} ${isEffectivelyMuted ? styles.muteBtnMuted : ''}`}
                      data-testid="participant-mute-btn"
                      aria-label={
                        isEffectivelyMuted
                          ? `Unmute ${peer.displayName}`
                          : `Mute ${peer.displayName}`
                      }
                      title={
                        isDeafened
                          ? 'Room audio is deafened'
                          : isEffectivelyMuted
                            ? `Unmute ${peer.displayName}`
                            : `Mute ${peer.displayName}`
                      }
                      onClick={() => handleTogglePeerMute(peer.peerIdSafe, effectiveVolume)}
                    >
                      <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                        {getVolumeIcon(effectiveVolume)}
                      </span>
                    </button>

                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={effectiveVolume}
                      aria-label={`Volume for ${peer.displayName}`}
                      data-testid="participant-volume-slider"
                      className={styles.volumeSlider}
                      onChange={(e) => onSetStreamVolume(peer.peerIdSafe, Number(e.target.value))}
                    />

                    {isDeafened && <span className={styles.deafenedChip}>Deafened</span>}

                    <span className={styles.volumeValue}>{effectiveVolume}%</span>
                  </div>
                )}

                <div className={styles.peerBottomRow}>
                  <span
                    className={`${styles.qualityBadge} ${quality.isLive ? styles.qualityLive : ''}`}
                  >
                    {quality.label}
                  </span>

                  <div className={styles.sparkWrap}>
                    <SparklineChart
                      data={sparkline.points}
                      color={sparkline.color}
                      height={28}
                      unit={sparkline.unit}
                      ariaLabel={`${peer.displayName} telemetry sparkline`}
                    />
                  </div>

                  <span className={`${styles.lossText} ${lossPct >= 2 ? styles.lossWarn : ''}`}>
                    {lossPct > 0 ? `${lossPct.toFixed(1)}% loss` : '0% loss'}
                  </span>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
