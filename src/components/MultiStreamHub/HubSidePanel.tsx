import React from 'react';
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
import { ParticipantsPanel } from './ParticipantsPanel';
import { TelemetryPanel } from './TelemetryPanel';

export type HubSidePanelTab = 'participants' | 'telemetry';

export interface HubSidePanelProps {
  isOpen: boolean;
  activeTab: HubSidePanelTab;
  onChangeTab: (tab: HubSidePanelTab) => void;
  onClose: () => void;
  hubId: string;
  localPeerIdSafe: string;
  localRole: RoomRole;
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
 * Right-hand room drawer hosting Participants controls and live Telemetry & Stats charts.
 */
export const HubSidePanel: React.FC<HubSidePanelProps> = ({
  isOpen,
  activeTab,
  onChangeTab,
  onClose,
  hubId,
  localPeerIdSafe,
  localRole,
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
  if (!isOpen) return null;

  return (
    <aside
      aria-label="Hub side panel"
      className={styles.sidePanel}
      data-testid="hub-side-panel"
    >
      <div className={styles.panelHeader}>
        <div className={styles.panelTitleWrap}>
          <span className={styles.pulseDot} />
          <span className={styles.panelTitle}>HUB PANEL</span>
        </div>

        <div className={styles.headerActions}>
          <button
            type="button"
            className={styles.hideBtn}
            onClick={onClose}
            title="Hide panel"
          >
            <span>Hide</span>
            <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
              chevron_right
            </span>
          </button>

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
      </div>

      <div className={styles.tabBar} role="tablist" aria-label="Hub panel sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'participants'}
          data-testid="hub-tab-participants"
          className={`${styles.tabBtn} ${
            activeTab === 'participants' ? styles.tabBtnActive : ''
          }`}
          onClick={() => onChangeTab('participants')}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
            group
          </span>
          <span>Participants ({peers.length})</span>
        </button>

        <button
          type="button"
          role="tab"
          aria-selected={activeTab === 'telemetry'}
          data-testid="hub-tab-telemetry"
          className={`${styles.tabBtn} ${
            activeTab === 'telemetry' ? styles.tabBtnActive : ''
          }`}
          onClick={() => onChangeTab('telemetry')}
        >
          <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
            monitoring
          </span>
          <span>Telemetry &amp; Stats</span>
        </button>
      </div>

      <div className={styles.tabBody}>
        {activeTab === 'participants' ? (
          <ParticipantsPanel
            hubId={hubId}
            localPeerIdSafe={localPeerIdSafe}
            localRole={localRole}
            peers={peers}
            streams={streams}
            streamVolumes={streamVolumes}
            isDeafened={isDeafened}
            fps={fps}
            resolution={resolution}
            systemMetrics={systemMetrics}
            peerTelemetryHistory={peerTelemetryHistory}
            onSetStreamVolume={onSetStreamVolume}
            onKickPeer={onKickPeer}
          />
        ) : (
          <TelemetryPanel
            fps={fps}
            isConnected={isConnected}
            systemMetrics={systemMetrics}
            telemetryHistory={telemetryHistory}
            hasActiveAudioStreams={streams.length > 0}
          />
        )}
      </div>
    </aside>
  );
};

export default HubSidePanel;
