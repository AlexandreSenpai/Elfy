import React, { useEffect, useRef, useState } from 'react';
import styles from './BottomDock.module.css';
import { StreamFpsOption, StreamResolutionPreset } from '../../domain/dtos';
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
  onSetFps: (fps: StreamFpsOption) => void | Promise<void>;
  resolution: StreamResolutionPreset;
  onSetResolution: (resolution: StreamResolutionPreset) => void | Promise<void>;
  onLeaveHub: () => void | Promise<void>;
}

const FPS_OPTIONS: readonly StreamFpsOption[] = [30, 60, 120];

const RESOLUTION_OPTIONS: ReadonlyArray<{ value: StreamResolutionPreset; label: string }> = [
  { value: '720p', label: '720p' },
  { value: '1080p', label: '1080p' },
  { value: 'source', label: 'Native' },
];

const getVolumeIcon = (isDeafened: boolean): string => {
  if (isDeafened) return 'headset_off';
  return 'headphones';
};

export const BottomDock: React.FC<BottomDockProps> = ({
  isDeafened,
  onToggleDeafen,
  isSharing,
  isLocalPreviewEnabled,
  onToggleShare,
  onToggleLocalPreview,
  fps,
  onSetFps,
  resolution,
  onSetResolution,
  onLeaveHub,
}) => {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsAnchorRef = useRef<HTMLDivElement | null>(null);
  const settingsBtnRef = useRef<HTMLButtonElement | null>(null);
  const { menuPosition, closeMenu, handleDockContextMenu } = useDockContextMenu();

  useEffect(() => {
    if (!settingsOpen) return;

    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null;
      if (settingsAnchorRef.current && target && !settingsAnchorRef.current.contains(target)) {
        setSettingsOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return;
      setSettingsOpen(false);
      settingsBtnRef.current?.focus();
    };

    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [settingsOpen]);

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

            <div className={styles.settingsAnchor} ref={settingsAnchorRef}>
              {settingsOpen && (
                <div
                  aria-label="Stream settings"
                  className={styles.settingsPopover}
                  data-testid="stream-settings-popover"
                  role="dialog"
                >
                  <div className={styles.popoverHeader}>
                    <span className={styles.popoverTitle}>Stream Settings</span>
                    <span className={styles.popoverSummary}>
                      {formatResolutionLabel(resolution)} · {fps} FPS
                    </span>
                  </div>

                  <div className={styles.popoverSection}>
                    <span className={styles.popoverLabel}>Frame Rate</span>
                    <div className={styles.segmentedGroup} role="group" aria-label="Frame rate">
                      {FPS_OPTIONS.map((option) => (
                        <button
                          key={option}
                          aria-pressed={fps === option}
                          className={`${styles.segmentedOption} ${
                            fps === option ? styles.segmentedOptionActive : ''
                          }`}
                          data-testid={`settings-fps-${option}`}
                          onClick={() => void onSetFps(option)}
                          type="button"
                        >
                          {option} FPS
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className={styles.popoverSection}>
                    <span className={styles.popoverLabel}>Quality</span>
                    <div className={styles.segmentedGroup} role="group" aria-label="Resolution quality">
                      {RESOLUTION_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          aria-pressed={resolution === option.value}
                          className={`${styles.segmentedOption} ${
                            resolution === option.value ? styles.segmentedOptionActive : ''
                          }`}
                          data-testid={`settings-resolution-${option.value}`}
                          onClick={() => void onSetResolution(option.value)}
                          type="button"
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {isSharing && (
                    <>
                      <div className={styles.popoverDivider} />
                      <button
                        aria-pressed={isLocalPreviewEnabled}
                        className={`${styles.previewToggleBtn} ${
                          isLocalPreviewEnabled ? styles.previewToggleBtnActive : ''
                        }`}
                        data-testid="dock-self-preview-btn"
                        onClick={onToggleLocalPreview}
                        title={
                          isLocalPreviewEnabled
                            ? 'Hide Self-Preview (saves GPU & RAM)'
                            : 'Preview My Stream locally (uses extra GPU & RAM)'
                        }
                        type="button"
                      >
                        <span className={styles.previewToggleLeft}>
                          <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>
                            {isLocalPreviewEnabled ? 'visibility' : 'visibility_off'}
                          </span>
                          <span>Self-Preview</span>
                        </span>
                        <span
                          className={`${styles.previewStateBadge} ${
                            isLocalPreviewEnabled ? styles.previewStateBadgeOn : ''
                          }`}
                        >
                          {isLocalPreviewEnabled ? 'On' : 'Off'}
                        </span>
                      </button>
                    </>
                  )}
                </div>
              )}

              <button
                ref={settingsBtnRef}
                aria-expanded={settingsOpen}
                aria-haspopup="dialog"
                aria-label="Stream settings"
                className={`${styles.settingsBtn} ${settingsOpen ? styles.settingsBtnActive : ''}`}
                data-testid="stream-settings-btn"
                onClick={() => setSettingsOpen((prev) => !prev)}
                title="Stream quality, FPS & preview settings"
                type="button"
              >
                <span className={styles.settingsChipText}>
                  {formatResolutionLabel(resolution)} · {fps} FPS
                </span>
                <span
                  className={`material-symbols-outlined ${styles.settingsGearIcon}`}
                  style={{ fontSize: '17px' }}
                >
                  settings
                </span>
              </button>
            </div>
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
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              call_end
            </span>
            <span className={styles.leaveLabel}>Leave</span>
          </button>
        </div>
      </footer>
      <DockContextMenu position={menuPosition} onClose={closeMenu} />
    </>
  );
};

export default BottomDock;
