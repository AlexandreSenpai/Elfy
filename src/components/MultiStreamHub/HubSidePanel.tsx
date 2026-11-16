import React, { useEffect } from 'react';
import styles from './HubSidePanel.module.css';
import {
  PeerTelemetryHistoryPointDto,
  RoomPeerDto,
  RoomRole,
  StreamFpsOption,
  StreamItem,
  StreamResolutionPreset,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
} from '../../domain/dtos';
import { ParticipantsPanel, isPeerActivelyStreaming } from './ParticipantsPanel';
import { TelemetryPanel } from './TelemetryPanel';

export interface HubSidePanelProps {
  isOpen: boolean;
  inspectedPeerIdSafe: string | null;
  onSelectTelemetryPeer: (peerIdSafe: string | null) => void;
  onClose: () => void;
  localPeerIdSafe: string;
  localRole: RoomRole;
  isSharing: boolean;
  peers: RoomPeerDto[];
  streams: StreamItem[];
  streamVolumes: Record<string, number>;
  isDeafened: boolean;
  fps: StreamFpsOption;
  resolution: StreamResolutionPreset;
  isConnected: boolean;
  systemMetrics: SystemMetricsDto;
  telemetryHistory: TelemetryHistoryPointDto[];
  peerTelemetryHistory: Record<string, PeerTelemetryHistoryPointDto[]>;
  onSetStreamVolume: (peerIdSafe: string, volume: number) => void;
  onKickPeer: (peerIdSafe: string, reason?: string) => void | Promise<void>;
}

/**
 * Right-hand room drawer showing the connected users list and, when triggered
 * from a streaming participant's telemetry icon, that specific user's real-time
 * stream telemetry.
 */
export const HubSidePanel: React.FC<HubSidePanelProps> = ({
  isOpen,
  inspectedPeerIdSafe,
  onSelectTelemetryPeer,
  onClose,
  localPeerIdSafe,
  localRole,
  isSharing,
  peers,
  streams,
  streamVolumes,
  isDeafened,
  fps,
  resolution,
  isConnected,
  systemMetrics,
  telemetryHistory,
  peerTelemetryHistory,
  onSetStreamVolume,
  onKickPeer,
}) => {
  const activeStreamingPeers = peers.filter((peer) =>
    isPeerActivelyStreaming(peer, localPeerIdSafe, isSharing, streams)
  );
  const inspectedPeer = inspectedPeerIdSafe
    ? activeStreamingPeers.find((peer) => peer.peerIdSafe === inspectedPeerIdSafe) ?? null
    : null;

  useEffect(() => {
    if (inspectedPeerIdSafe && !inspectedPeer) {
      onSelectTelemetryPeer(null);
    }
  }, [inspectedPeer, inspectedPeerIdSafe, onSelectTelemetryPeer]);

  if (!isOpen) return null;

  const isViewingTelemetry = inspectedPeer !== null;
  const inspectedStream = inspectedPeer
    ? streams.find((stream) => stream.peerIdSafe === inspectedPeer.peerIdSafe)
    : undefined;

  return (
    <aside
      aria-label="Hub side panel"
      className={styles.sidePanel}
      data-testid="hub-side-panel"
    >
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleWrap}>
          <span className={styles.pulseDot} />
          <span className={styles.panelTitle}>
            {isViewingTelemetry ? 'STREAM TELEMETRY' : `PARTICIPANTS (${peers.length})`}
          </span>
        </div>

        <button
          type="button"
          className={styles.closeBtn}
          data-testid="close-hub-panel-btn"
          aria-label="Close Hub Panel"
          title="Close Hub Panel"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      {isViewingTelemetry && (
        <div className={styles.telemetryTopBar}>
          <button
            type="button"
            className={styles.backBtn}
            data-testid="telemetry-back-btn"
            onClick={() => onSelectTelemetryPeer(null)}
            title="Back to Participants"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
              arrow_back
            </span>
            <span>Users ({peers.length})</span>
          </button>

          {activeStreamingPeers.length > 1 && (
            <div className={styles.streamerSwitchRow} role="group" aria-label="Switch active streamer">
              {activeStreamingPeers.map((streamer) => (
                <button
                  key={streamer.peerIdSafe}
                  type="button"
                  data-testid={`telemetry-switch-${streamer.peerIdSafe}`}
                  aria-pressed={streamer.peerIdSafe === inspectedPeer.peerIdSafe}
                  className={`${styles.streamerChip} ${
                    streamer.peerIdSafe === inspectedPeer.peerIdSafe ? styles.streamerChipActive : ''
                  }`}
                  onClick={() => onSelectTelemetryPeer(streamer.peerIdSafe)}
                >
                  {streamer.displayName}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <div className={styles.tabBody}>
        {isViewingTelemetry ? (
          <TelemetryPanel
            peer={inspectedPeer}
            isLocal={inspectedPeer.peerIdSafe === localPeerIdSafe}
            peerStream={inspectedStream}
            localFpsSetting={fps}
            localResolutionSetting={resolution}
            isConnected={isConnected}
            systemMetrics={systemMetrics}
            localHistory={telemetryHistory}
            peerHistory={peerTelemetryHistory[inspectedPeer.peerIdSafe] ?? []}
          />
        ) : (
          <ParticipantsPanel
            localPeerIdSafe={localPeerIdSafe}
            localRole={localRole}
            isSharing={isSharing}
            peers={peers}
            streams={streams}
            streamVolumes={streamVolumes}
            isDeafened={isDeafened}
            fps={fps}
            resolution={resolution}
            systemMetrics={systemMetrics}
            telemetryHistory={telemetryHistory}
            peerTelemetryHistory={peerTelemetryHistory}
            onSetStreamVolume={onSetStreamVolume}
            onKickPeer={onKickPeer}
            onInspectPeerTelemetry={(peerIdSafe) => onSelectTelemetryPeer(peerIdSafe)}
          />
        )}
      </div>
    </aside>
  );
};

export default HubSidePanel;
