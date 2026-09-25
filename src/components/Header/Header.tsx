import React, { useState } from 'react';
import styles from './Header.module.css';
import { UserProfile } from '../../types';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import {
  closeStreamWindowTauri,
  minimizeWindowTauri,
  startDraggingTauri,
  toggleMaximizeWindowTauri
} from '../../utils/tauri';

interface HeaderProps {
  profile: UserProfile;
  activeStreamsCount: number;
  onCloseStream?: () => void;
  onOpenProfile?: () => void;
  roomTitle?: string;
}

export const Header: React.FC<HeaderProps> = ({
  profile,
  activeStreamsCount,
  onCloseStream,
  onOpenProfile
}) => {
  const [copied, setCopied] = useState(false);

  const handleCopyLink = () => {
    navigator.clipboard?.writeText('elfy.link/treehouse').catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleMinimize = async () => {
    await minimizeWindowTauri();
  };

  const handleMaximize = async () => {
    await toggleMaximizeWindowTauri();
  };

  const handleClose = async () => {
    if (onCloseStream) {
      onCloseStream();
    }
    await closeStreamWindowTauri();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    // Double click to toggle maximize/restore
    if (e.detail === 2) {
      e.preventDefault();
      toggleMaximizeWindowTauri();
      return;
    }
    // Single click starts dragging immediately
    startDraggingTauri();
  };

  const handleDoubleClick = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    toggleMaximizeWindowTauri();
  };

  return (
    <header
      className={styles.header}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
    >
      {/* Left: Brand & Room Info (NO tab selector, NO mock mac dots) */}
      <div className={styles.leftSection}>
        <div className={styles.brandWrap}>
          <div className={styles.mascotLogo}>
            <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" className={styles.mascotImg} />
          </div>
          <span className={styles.brandTitle}>Elfy</span>
        </div>

        <span className={styles.slashDivider}>/</span>

        <div className={styles.roomInfo}>

          <span className={styles.activeBadge}>
            {activeStreamsCount} Streams Active
          </span>
        </div>
      </div>

      {/* Right: Latency, Quick Copy, Avatar, and Real Window Controls */}
      <div className={styles.rightSection}>
        <div className={styles.meshBadge}>
          <span className={styles.pulseDot} />
          <span>12ms P2P Mesh</span>
        </div>

        <button className={styles.inviteBtn} onClick={handleCopyLink} type="button">
          <span className={`material-symbols-outlined ${styles.inviteIcon}`}>link</span>
          <span className={styles.inviteText}>elfy/hub/{profile.nickname}{profile.peerTag}</span>
          {copied && <span className={styles.copiedTag}>Copied!</span>}
        </button>

        <div
          className={styles.avatarWrap}
          onClick={onOpenProfile}
          role="button"
          tabIndex={0}
          data-no-drag="true"
          title={`Edit Persona (${profile.nickname}${profile.peerTag})`}
        >
          <div className={styles.userAvatar}>
            <img src={profile.avatarUrl} alt={profile.nickname} className={styles.avatarImg} />
          </div>
          <span className={styles.onlineIndicator} />
        </div>

        {/* Real Desktop Window Actions */}
        <div className={styles.windowActions}>
          <button
            className={styles.winBtn}
            onClick={handleMinimize}
            title="Minimize"
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              minimize
            </span>
          </button>

          <button
            className={styles.winBtn}
            onClick={handleMaximize}
            title="Maximize / Restore"
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
              crop_square
            </span>
          </button>

          <button
            className={`${styles.winBtn} ${styles.winBtnClose}`}
            onClick={handleClose}
            title="Close Stream Window"
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              close
            </span>
          </button>
        </div>
      </div>
    </header>
  );
};
