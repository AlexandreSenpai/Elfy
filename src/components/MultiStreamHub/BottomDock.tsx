import React from 'react';
import styles from './BottomDock.module.css';
import {
  StreamFpsOption,
  StreamResolutionPreset,
  SystemMetricsDto,
  WatchLayoutMode,
} from '../../domain/dtos';
import { formatResolutionLabel } from '../../hooks/room/roomHelpers';
import { DockContextMenu, useDockContextMenu } from '../DockContextMenu/DockContextMenu';

interface BottomDockProps {
  isDeafened: boolean;
  onToggleDeafen: () => void;
  isSharing: boolean;
  isLocalPreviewEnabled: boolean;
  onToggleShare: () => void | Promise<void>;
  onToggleLocalPreview: () => void;
  fps: StreamFpsOption;
  onToggleFps: () => void | Promise<void>;
  resolution: StreamResolutionPreset;
  onCycleResolution: () => void | Promise<void>;
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

const formatEncoderSuffix = (metrics: SystemMetricsDto): string => {
  const effectiveKbps =
    metrics.outboundBitrateKbps > 0 ? metrics.outboundBitrateKbps : metrics.inboundBitrateKbps;
  if (!metrics.activeCodec && effectiveKbps <= 0 && metrics.rttMs <= 0) return '';

  const accelPrefix =
    metrics.isHardwareAccelerated === true
      ? 'HW'
      : metrics.isHardwareAccelerated === false
        ? 'SW'
        : '';
  const codecPart = [accelPrefix, metrics.activeCodec].filter(Boolean).join(' ');
  const mbpsPart = effectiveKbps > 0 ? `${(effectiveKbps / 1000).toFixed(1)}Mbps` : '';
  const rttPart = metrics.rttMs > 0 ? `${Math.round(metrics.rttMs)}ms` : '';
  const combined = [codecPart, mbpsPart, rttPart].filter(Boolean).join(' · ');
  return combined ? ` · ${combined}` : '';
};

const getLayoutMeta = (layoutMode: WatchLayoutMode): { icon: string; label: string } => {
  if (layoutMode === 'spotlight') return { icon: 'view_sidebar', label: 'Spotlight' };
  if (layoutMode === 'focus') return { icon: 'center_focus_strong', label: 'Focus' };
  return { icon: 'grid_view', label: 'Grid' };
};

export const BottomDock: React.FC<BottomDockProps> = ({
  isDeafened,
  onToggleDeafen,
  isSharing,
  isLocalPreviewEnabled,
  onToggleShare,
  onToggleLocalPreview,
  fps,
  onToggleFps,
  resolution,
  onCycleResolution,
  layoutMode,
  onToggleLayout,
  onMinimizeHub,
  systemMetrics,
  onLeaveHub,
}) => {
  const { menuPosition, closeMenu, handleDockContextMenu } = useDockContextMenu();
  const cpuPct = Math.round(systemMetrics.cpuUsagePercent);
  const ramMb = Math.round(systemMetrics.memoryUsedMb);
  const effectiveFps = Math.round(
    systemMetrics.outboundFps || systemMetrics.inboundFps || fps
  );
  const encoderSuffix = formatEncoderSuffix(systemMetrics);
  const layoutMeta = getLayoutMeta(layoutMode);

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
            aria-pressed={isDeafened}
            className={`${styles.deafenBtn} ${isDeafened ? styles.iconBtnDeafened : ''}`}
            data-testid="deafen-toggle-btn"
            onClick={onToggleDeafen}
            title={isDeafened ? 'Undeafen Audio' : 'Deafen Audio'}
            type="button"
          >
            <span
              className="material-symbols-outlined"
              style={{
                fontSize: '18px',
                color: isDeafened ? 'var(--error)' : 'var(--on-surface-variant)',
              }}
            >
              {getVolumeIcon(isDeafened)}
            </span>
            <span className={styles.deafenLabel}>{isDeafened ? 'Deafened' : 'Deafen'}</span>
          </button>

          <div className={styles.dockDivider} />

          <div className={styles.centerControls}>
            <button
              className={`${styles.shareBtn} ${isSharing ? styles.shareBtnActive : ''}`}
              data-testid="toggle-share-btn"
              onClick={() => void onToggleShare()}
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                {isSharing ? 'stop_screen_share' : 'screen_share'}
              </span>
              <span>{isSharing ? 'Stop Sharing' : 'Share Screen'}</span>
            </button>

            {isSharing && (
              <button
                aria-pressed={isLocalPreviewEnabled}
                className={`${styles.modeBtn} ${isLocalPreviewEnabled ? styles.modeBtnActive : ''}`}
                data-testid="dock-self-preview-btn"
                onClick={onToggleLocalPreview}
                title={
                  isLocalPreviewEnabled
                    ? 'Hide Self-Preview (saves GPU & RAM)'
                    : 'Preview My Stream locally (uses extra GPU & RAM)'
                }
                type="button"
              >
                <span className={`material-symbols-outlined ${styles.modeIcon}`} style={{ fontSize: '17px' }}>
                  {isLocalPreviewEnabled ? 'visibility' : 'visibility_off'}
                </span>
                <span className={styles.modeLabel}>
                  {isLocalPreviewEnabled ? 'Preview On' : 'Preview'}
                </span>
              </button>
            )}

            <button
              className={`${styles.pillBtn} ${fps === 30 ? styles.pillBtnEconomy : ''}`}
              data-testid="fps-toggle-btn"
              onClick={() => void onToggleFps()}
              title="Cycle stream frame rate: 60 / 30 / 120 FPS"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                speed
              </span>
              <span>{fps} FPS</span>
            </button>

            <button
              className={`${styles.pillBtn} ${resolution === '720p' ? styles.pillBtnEconomy : ''}`}
              data-testid="resolution-toggle-btn"
              onClick={() => void onCycleResolution()}
              title="Cycle capture resolution: 1080p / 720p / Native"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                high_quality
              </span>
              <span>{formatResolutionLabel(resolution)}</span>
            </button>

            <button
              className={styles.modeBtn}
              data-testid="layout-toggle-btn"
              onClick={onToggleLayout}
              title="Toggle Grid / Spotlight View"
              type="button"
            >
              <span className={`material-symbols-outlined ${styles.modeIcon}`} style={{ fontSize: '17px' }}>
                {layoutMeta.icon}
              </span>
              <span className={styles.modeLabel}>{layoutMeta.label}</span>
            </button>

            <button
              aria-label="Minimize Hub"
              className={styles.iconBtn}
              data-testid="minimize-hub-btn"
              onClick={() => void onMinimizeHub()}
              title="Minimize Hub Without Disconnecting"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                picture_in_picture_alt
              </span>
            </button>
          </div>

          <div className={styles.dockDivider} />

          <div className={styles.rightControls}>
            <div
              className={`${styles.metricsBadge} ${systemMetrics.highLoadWarning ? styles.metricsBadgeHigh : ''}`}
              data-testid="system-metrics-badge"
              title={
                systemMetrics.encoderImplementation
                  ? `Encoder: ${systemMetrics.encoderImplementation}`
                  : 'Host CPU, Memory, FPS & Encoder Telemetry'
              }
            >
              <span className={styles.metricsDot} />
              <span className={styles.metricsText}>
                CPU {cpuPct}% · RAM {ramMb}MB · {effectiveFps} FPS{encoderSuffix}
              </span>
            </div>

            <button
              aria-label="Disconnect & Leave Room"
              className={styles.leaveBtn}
              data-testid="leave-hub-btn"
              onClick={() => void onLeaveHub()}
              title="Disconnect & Leave Room"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                call_end
              </span>
              <span className={styles.leaveLabel}>Leave</span>
            </button>
          </div>
        </div>
      </footer>
      <DockContextMenu position={menuPosition} onClose={closeMenu} />
    </>
  );
};

export default BottomDock;
