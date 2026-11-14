import React, { useState } from 'react';
import styles from './Header.module.css';
import { UserProfile } from '../../domain/dtos';
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

interface HeaderProps {
  profile: UserProfile;
  roomTitle: string;
  activeStreamsCount: number;
  rttMs?: number;
  isConnected?: boolean;
  onMinimizeHub?: () => void | Promise<void>;
  onCloseStream?: () => void | Promise<void>;
  onOpenProfile?: () => void | Promise<void>;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  roomTitle,
  activeStreamsCount,
  rttMs = 0,
  isConnected = false,
  onMinimizeHub,
  onCloseStream,
  onOpenProfile,
}) => {
  const [copied, setCopied] = useState(false);
  const { menuPosition, closeMenu, handleDockContextMenu } = useDockContextMenu();

  const fallbackHub = `elfy/hub/${formatFullPeerTag(profile.nickname, profile.peerTag)}`;
  const effectiveRoomTitle = roomTitle || fallbackHub;

  const getConnectionText = (): string => {
    if (rttMs > 0) return `${Math.round(rttMs)}ms P2P`;
    if (isConnected) return 'P2P Ready';
    return 'Connecting...';
  };

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

        <div className={styles.roomInfo}>
          <span className={styles.roomName} title={effectiveRoomTitle}>
            {effectiveRoomTitle}
          </span>
          <span className={styles.activeBadge}>
            {activeStreamsCount} {activeStreamsCount === 1 ? 'Stream' : 'Streams'} Active
          </span>
        </div>
      </div>

      <div className={styles.rightSection}>
        <div className={styles.meshBadge}>
          <span className={`${styles.pulseDot} ${!isConnected ? styles.pulseDotIdle : ''}`} />
          <span>{getConnectionText()}</span>
        </div>

        <button className={styles.inviteBtn} onClick={handleCopyLink} title="Copy Hub Invite Code" type="button">
          <span className={`material-symbols-outlined ${styles.inviteIcon}`}>link</span>
          <span className={styles.inviteText}>{effectiveRoomTitle}</span>
          {copied && <span className={styles.copiedTag}>Copied!</span>}
        </button>

        {onMinimizeHub && (
          <button
            className={styles.quickMinBtn}
            onClick={() => void onMinimizeHub()}
            title="Minimize Hub to Companion Bar"
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
              picture_in_picture_alt
            </span>
          </button>
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
            className={styles.winBtn}
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
