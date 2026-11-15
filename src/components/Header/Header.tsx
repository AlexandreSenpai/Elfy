import React, { useState } from 'react';
import styles from './Header.module.css';
import { RoomPeerDto, UserProfile, WatchLayoutMode } from '../../domain/dtos';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { formatFullPeerTag } from '../../utils/hubTopics';
import {
  beginWindowDragOnMove,
  closeStreamWindowTauri,
  isTauri,
  minimizeWindowTauri,
  toggleMaximizeWindowTauri,
} from '../../utils/tauri';
import { DockContextMenu, useDockContextMenu } from '../DockContextMenu/DockContextMenu';
import type { HubSidePanelTab } from '../MultiStreamHub/HubSidePanel';

interface HeaderProps {
  profile: UserProfile;
  roomTitle: string;
  layoutMode?: WatchLayoutMode;
  onSelectLayoutMode?: (mode: WatchLayoutMode) => void;
  peers?: RoomPeerDto[];
  activePanelTab?: HubSidePanelTab | null;
  onTogglePanelTab?: (tab: HubSidePanelTab) => void;
  onMinimizeHub?: () => void | Promise<void>;
  onCloseStream?: () => void | Promise<void>;
  onOpenProfile?: () => void | Promise<void>;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  roomTitle,
  layoutMode,
  onSelectLayoutMode,
  peers,
  activePanelTab = null,
  onTogglePanelTab,
  onMinimizeHub,
  onCloseStream,
  onOpenProfile,
}) => {
  const [copied, setCopied] = useState(false);
  const { menuPosition, closeMenu, handleDockContextMenu } = useDockContextMenu();

  const fallbackHub = `elfy/hub/${formatFullPeerTag(profile.nickname, profile.peerTag)}`;
  const effectiveRoomTitle = roomTitle || fallbackHub;

  const handleCopyLink = (): void => {
    navigator.clipboard?.writeText(effectiveRoomTitle).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const handleMinimizeWindow = async (): Promise<void> => {
    if (onMinimizeHub) {
      await onMinimizeHub();
      return;
    }
    await minimizeWindowTauri();
  };

  const handleMaximizeWindow = async (): Promise<void> => {
    await toggleMaximizeWindowTauri();
  };

  const handleClose = async (): Promise<void> => {
    await onCloseStream?.();
    if (isTauri()) {
      await closeStreamWindowTauri();
    }
  };

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    if (e.detail === 2) {
      e.preventDefault();
      void toggleMaximizeWindowTauri();
      return;
    }
    beginWindowDragOnMove(e.clientX, e.clientY);
  };

  const handleDoubleClick = (e: React.MouseEvent): void => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    void toggleMaximizeWindowTauri();
  };

  const showRoomControls = Boolean(layoutMode && onSelectLayoutMode);
  const showPanelControls = Boolean(peers && onTogglePanelTab);
  const previewPeers = (peers ?? []).slice(0, 3);

  return (
    <>
      <header
        className={styles.header}
        onContextMenu={handleDockContextMenu}
        onDoubleClick={handleDoubleClick}
        onMouseDown={handleMouseDown}
      >
        <div className={styles.leftSection}>
          <div
            className={styles.brandWrap}
            data-testid="dock-brand-trigger"
            title="Right-click for Elfy options"
          >
            <div className={styles.mascotLogo}>
              <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" className={styles.mascotImg} />
            </div>
            <span className={styles.brandTitle}>Elfy</span>
          </div>

          <span className={styles.slashDivider}>/</span>

          <span className={styles.roomName} title={effectiveRoomTitle}>
            {effectiveRoomTitle}
          </span>
        </div>

        {showRoomControls && layoutMode && onSelectLayoutMode && (
          <div
            aria-label="Stream layout mode"
            className={styles.layoutSwitcher}
            data-no-drag="true"
            role="group"
          >
            <button
              aria-pressed={layoutMode === 'grid'}
              className={`${styles.layoutPill} ${layoutMode === 'grid' ? styles.layoutPillActive : ''}`}
              data-testid="layout-mode-grid"
              onClick={() => onSelectLayoutMode('grid')}
              title="Grid View"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                grid_view
              </span>
              <span>Grid</span>
            </button>

            <button
              aria-pressed={layoutMode === 'spotlight'}
              className={`${styles.layoutPill} ${layoutMode === 'spotlight' ? styles.layoutPillActive : ''}`}
              data-testid="layout-mode-spotlight"
              onClick={() => onSelectLayoutMode('spotlight')}
              title="Spotlight View"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                view_sidebar
              </span>
              <span>Spotlight</span>
            </button>

            <button
              aria-pressed={layoutMode === 'focus'}
              className={`${styles.layoutPill} ${layoutMode === 'focus' ? styles.layoutPillActive : ''}`}
              data-testid="layout-mode-focus"
              onClick={() => onSelectLayoutMode('focus')}
              title="Focus View"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                center_focus_strong
              </span>
              <span>Focus</span>
            </button>
          </div>
        )}

        <div className={styles.rightSection}>
          <button
            className={styles.inviteBtn}
            onClick={handleCopyLink}
            title="Copy Hub Invite Code"
            type="button"
          >
            <span className={`material-symbols-outlined ${styles.inviteIcon}`}>link</span>
            <span className={styles.inviteText}>{effectiveRoomTitle}</span>
            {copied && <span className={styles.copiedTag}>Copied!</span>}
          </button>

          {showPanelControls && peers && onTogglePanelTab && (
            <div className={styles.panelBtnGroup}>
              <button
                aria-label="Toggle Participants panel"
                aria-pressed={activePanelTab === 'participants'}
                className={`${styles.participantsPill} ${
                  activePanelTab === 'participants' ? styles.panelPillActive : ''
                }`}
                data-testid="toggle-participants-panel-btn"
                onClick={() => onTogglePanelTab('participants')}
                title="Participants & Room Controls"
                type="button"
              >
                <span className={styles.avatarStack}>
                  {previewPeers.length > 0 ? (
                    previewPeers.map((peer) => (
                      <img
                        key={peer.peerIdSafe}
                        src={peer.avatarUrl || ELFY_MASCOT_ICON}
                        alt={peer.displayName}
                        className={styles.stackAvatar}
                      />
                    ))
                  ) : (
                    <img
                      src={profile.avatarUrl || ELFY_MASCOT_ICON}
                      alt={profile.nickname}
                      className={styles.stackAvatar}
                    />
                  )}
                </span>
                <span className={styles.participantsCount}>{peers.length}</span>
              </button>

              <button
                aria-label="Toggle Telemetry & Stats panel"
                aria-pressed={activePanelTab === 'telemetry'}
                className={`${styles.telemetryBtn} ${
                  activePanelTab === 'telemetry' ? styles.panelPillActive : ''
                }`}
                data-testid="toggle-telemetry-panel-btn"
                onClick={() => onTogglePanelTab('telemetry')}
                title="Telemetry & Stats"
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  monitoring
                </span>
              </button>
            </div>
          )}

          <button
            aria-label={`Edit Persona (${profile.nickname}${profile.peerTag})`}
            className={styles.avatarWrap}
            data-no-drag="true"
            onClick={() => void onOpenProfile?.()}
            title={`Edit Persona (${profile.nickname}${profile.peerTag})`}
            type="button"
          >
            <div className={styles.userAvatar}>
              <img src={profile.avatarUrl} alt={profile.nickname} className={styles.avatarImg} />
            </div>
            <span className={styles.onlineIndicator} />
          </button>

          <div className={styles.windowActions}>
            <button
              aria-label="Minimize Window"
              className={styles.winBtn}
              data-testid="minimize-window-btn"
              onClick={() => void handleMinimizeWindow()}
              title="Minimize Window"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                minimize
              </span>
            </button>

            {isTauri() && (
              <button
                aria-label="Maximize / Restore"
                className={styles.winBtn}
                onClick={() => void handleMaximizeWindow()}
                title="Maximize / Restore"
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                  crop_square
                </span>
              </button>
            )}

            <button
              aria-label="Close Watch Room"
              className={`${styles.winBtn} ${styles.winBtnClose}`}
              onClick={() => void handleClose()}
              title="Close Watch Room"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                close
              </span>
            </button>
          </div>
        </div>
      </header>
      <DockContextMenu position={menuPosition} onClose={closeMenu} />
    </>
  );
};

export default Header;
