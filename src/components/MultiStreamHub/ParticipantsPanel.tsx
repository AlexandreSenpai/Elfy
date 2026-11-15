import React, { useEffect, useRef, useState } from 'react';
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
} from '../../domain/dtos';
import { formatResolutionLabel } from '../../hooks/room/roomHelpers';
import { SparklineChart, SparklinePoint } from './TelemetryCharts';
import { getVolumeIcon } from './StreamTile';

export interface ParticipantsPanelProps {
  hubId: string;
  localPeerIdSafe: string;
  localRole: RoomRole;
  peers: RoomPeerDto[];
  streams: StreamItem[];
  streamVolumes: Record<string, number>;
  isDeafened: boolean;
  fps: StreamFpsOption;
  resolution: StreamResolutionPreset;
  systemMetrics: SystemMetricsDto;
  peerTelemetryHistory: Record<string, PeerTelemetryHistoryPointDto[]>;
  onSetStreamVolume: (peerIdSafe: string, volume: number) => void;
  onKickPeer: (peerIdSafe: string, reason?: string) => void | Promise<void>;
}

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

const buildPeerSparkline = (
  history: PeerTelemetryHistoryPointDto[] | undefined,
  liveStats: PeerTelemetryDto | undefined
): { points: SparklinePoint[]; color: string; unit: string } => {
  const samples = history ?? [];
  const hasBitrate =
    samples.some((point) => point.bitrateKbps > 0) || (liveStats?.bitrateKbps ?? 0) > 0;

  if (hasBitrate) {
    const points = samples.map((point) => ({
      value: Math.round(point.bitrateKbps),
      label: formatSampleTime(point.timestamp),
    }));
    if (points.length === 0 && liveStats) {
      points.push({ value: Math.round(liveStats.bitrateKbps), label: 'Now' });
    }
    return { points, color: '#ff4d6d', unit: 'kbps' };
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
  peer: RoomPeerDto,
  isLocal: boolean,
  peerStream: StreamItem | undefined,
  hasAnyActiveStream: boolean,
  localResolution: StreamResolutionPreset,
  localFps: StreamFpsOption
): { label: string; isLive: boolean } => {
  if (peerStream) {
    return { label: `${peerStream.resolution} ${peerStream.fps}fps`, isLive: true };
  }
  if (peer.isStreaming) {
    if (isLocal) {
      return { label: `${formatResolutionLabel(localResolution)} ${localFps}fps`, isLive: true };
    }
    return { label: 'Live Stream', isLive: true };
  }
  if (hasAnyActiveStream) {
    return { label: 'Watching', isLive: false };
  }
  return { label: 'Idle', isLive: false };
};

export const ParticipantsPanel: React.FC<ParticipantsPanelProps> = ({
  hubId,
  localPeerIdSafe,
  localRole,
  peers,
  streams,
  streamVolumes,
  isDeafened,
  fps,
  resolution,
  systemMetrics,
  peerTelemetryHistory,
  onSetStreamVolume,
  onKickPeer,
}) => {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<number | null>(null);
  const lastNonZeroVolumeRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyInvite = (): void => {
    if (hubId) {
      navigator.clipboard?.writeText(hubId).catch(() => {});
    }
    setCopied(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopied(false);
    }, 2000);
  };

  const handleTogglePeerMute = (peerIdSafe: string, currentVolume: number): void => {
    if (currentVolume > 0) {
      lastNonZeroVolumeRef.current.set(peerIdSafe, currentVolume);
      onSetStreamVolume(peerIdSafe, 0);
      return;
    }
    const restored = lastNonZeroVolumeRef.current.get(peerIdSafe) ?? 100;
    onSetStreamVolume(peerIdSafe, restored > 0 ? restored : 100);
  };

  const hasAnyActiveStream = streams.length > 0 || peers.some((peer) => peer.isStreaming);

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
            const isLive = peer.isStreaming || Boolean(peerStream);

            const liveStats = systemMetrics.peerStats?.[peer.peerIdSafe];
            const history = peerTelemetryHistory[peer.peerIdSafe];
            const latestHistory =
              history && history.length > 0 ? history[history.length - 1] : undefined;

            const rttMs = isLocal ? 0 : liveStats?.rttMs ?? latestHistory?.rttMs ?? 0;
            const lossPct = isLocal
              ? systemMetrics.packetLossPercent
              : liveStats?.packetLossPercent ?? latestHistory?.packetLossPercent ?? 0;

            const rawSavedVolume = streamVolumes[peer.peerIdSafe] ?? peerStream?.volume ?? 100;
            const effectiveVolume = isDeafened ? 0 : rawSavedVolume;
            const isEffectivelyMuted = effectiveVolume === 0;

            if (rawSavedVolume > 0) {
              lastNonZeroVolumeRef.current.set(peer.peerIdSafe, rawSavedVolume);
            }

            const sparkline = isLocal
              ? {
                  points:
                    systemMetrics.outboundBitrateKbps > 0
                      ? [{ value: Math.round(systemMetrics.outboundBitrateKbps), label: 'Now' }]
                      : [],
                  color: '#ff4d6d',
                  unit: 'kbps',
                }
              : buildPeerSparkline(history, liveStats);

            const quality = resolveQualityText(
              peer,
              isLocal,
              peerStream,
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
                      {rttMs > 0 ? `${Math.round(rttMs)}ms` : '--ms'}
                    </span>

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

      <div className={styles.inviteCard}>
        <div className={styles.inviteMeta}>
          <span className={styles.inviteTitle}>Invite to Room</span>
          <span className={styles.inviteSubtitle} title={hubId}>
            Share instant hub code
          </span>
        </div>

        <button
          type="button"
          className={`${styles.inviteBtn} ${copied ? styles.inviteBtnCopied : ''}`}
          data-testid="invite-copy-btn"
          onClick={handleCopyInvite}
        >
          {copied && (
            <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
              check
            </span>
          )}
          <span>{copied ? 'Copied!' : '+ Invite'}</span>
        </button>
      </div>
    </div>
  );
};
