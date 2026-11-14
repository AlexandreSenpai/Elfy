import React from 'react';
import styles from './BottomDock.module.css';
import { StreamFpsOption, SystemMetricsDto, WatchLayoutMode } from '../../domain/dtos';
import { DockContextMenu, useDockContextMenu } from '../DockContextMenu/DockContextMenu';

interface BottomDockProps {
  isDeafened: boolean;
  onToggleDeafen: () => void;
  isSharing: boolean;
  onToggleShare: () => void | Promise<void>;
  fps: StreamFpsOption;
  onToggleFps: () => void | Promise<void>;
  layoutMode: WatchLayoutMode;
  onToggleLayout: () => void;
  onMinimizeHub: () => void | Promise<void>;
  systemMetrics: SystemMetricsDto;
  onLeaveHub: () => void | Promise<void>;
}

const getVolumeIcon = (isDeafened: boolean): string => {
  if (isDeafened) return 'headset_off';
  return 'headphones';
};

export const BottomDock: React.FC<BottomDockProps> = ({
  isDeafened,
  onToggleDeafen,
  isSharing,
  onToggleShare,
  fps,
  onToggleFps,
  layoutMode,
  onToggleLayout,
  onMinimizeHub,
  systemMetrics,
  onLeaveHub,
}) => {
  const { menuPosition, closeMenu, handleDockContextMenu } = useDockContextMenu();
  const isGridMode = layoutMode === 'grid';
  const cpuPct = Math.round(systemMetrics.cpuUsagePercent);
  const ramMb = Math.round(systemMetrics.memoryUsedMb);
  const effectiveFps = Math.round(
    systemMetrics.outboundFps || systemMetrics.inboundFps || fps
  );

  return (
    <>
      <footer
        className={styles.dockWrapper}
        data-testid="bottom-dock"
        onContextMenu={handleDockContextMenu}
        title="Right-click for Elfy options"
      >
        <div className={styles.dockContainer}>
        <button
          aria-label={isDeafened ? 'Undeafen Audio' : 'Deafen Audio'}
          className={`${styles.iconBtn} ${isDeafened ? styles.iconBtnDeafened : ''}`}
          data-testid="deafen-toggle-btn"
          onClick={onToggleDeafen}
          title={isDeafened ? 'Undeafen Audio' : 'Deafen Audio'}
          type="button"
        >
          <span
            className="material-symbols-outlined"
            style={{
              fontSize: '20px',
              color: isDeafened ? 'var(--error)' : 'var(--on-surface-variant)',
            }}
          >
            {getVolumeIcon(isDeafened)}
          </span>
        </button>

        <div className={styles.dockDivider} />

        <button
          className={`${styles.shareBtn} ${isSharing ? styles.shareBtnActive : ''}`}
          data-testid="toggle-share-btn"
          onClick={() => void onToggleShare()}
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '19px' }}>
            {isSharing ? 'stop_screen_share' : 'screen_share'}
          </span>
          <span>{isSharing ? 'Stop Sharing' : 'Share Screen'}</span>
        </button>

        <button
          className={`${styles.pillBtn} ${fps === 30 ? styles.pillBtnEconomy : ''}`}
          data-testid="fps-toggle-btn"
          onClick={() => void onToggleFps()}
          title="Switch between 60 FPS and 30 FPS"
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>
            speed
          </span>
          <span>{fps} FPS</span>
        </button>

        <button
          className={styles.modeBtn}
          data-testid="layout-toggle-btn"
          onClick={onToggleLayout}
          title="Toggle Grid / Spotlight View"
          type="button"
        >
          <span className={`material-symbols-outlined ${styles.modeIcon}`} style={{ fontSize: '18px' }}>
            {isGridMode ? 'grid_view' : 'view_sidebar'}
          </span>
          <span className={styles.modeLabel}>{isGridMode ? 'Grid View' : 'Spotlight'}</span>
        </button>

        <button
          aria-label="Minimize Hub"
          className={styles.iconBtn}
          data-testid="minimize-hub-btn"
          onClick={() => void onMinimizeHub()}
          title="Minimize Hub Without Disconnecting"
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '19px' }}>
            picture_in_picture_alt
          </span>
        </button>

        <div
          className={`${styles.metricsBadge} ${systemMetrics.highLoadWarning ? styles.metricsBadgeHigh : ''}`}
          data-testid="system-metrics-badge"
          title="Host CPU, Memory & Stream FPS Telemetry"
        >
          <span className={styles.metricsDot} />
          <span>
            CPU {cpuPct}% · RAM {ramMb}MB · {effectiveFps} FPS
          </span>
        </div>

        <div className={styles.dockDivider} />

        <button
          aria-label="Disconnect & Leave Room"
          className={styles.leaveBtn}
          data-testid="leave-hub-btn"
          onClick={() => void onLeaveHub()}
          title="Disconnect & Leave Room"
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
            call_end
          </span>
        </button>
      </div>
    </footer>
      <DockContextMenu position={menuPosition} onClose={closeMenu} />
    </>
  );
};

export default BottomDock;
