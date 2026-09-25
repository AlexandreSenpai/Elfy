import React from 'react';
import styles from './BottomDock.module.css';

interface BottomDockProps {
  isDeafened: boolean;
  onToggleDeafen: () => void;
  isSharing: boolean;
  onToggleShare: () => void;
  isGridMode: boolean;
  onToggleLayout: () => void;
  onOpenSettings: () => void;
  onLeaveHub: () => void;
}

export const BottomDock: React.FC<BottomDockProps> = ({
  isDeafened,
  onToggleDeafen,
  isSharing,
  onToggleShare,
  isGridMode,
  onToggleLayout,
  onOpenSettings,
  onLeaveHub
}) => {
  return (
    <footer className={styles.dockWrapper}>
      <div className={styles.dockContainer}>
        {/* Deafen Toggle */}
        <button
          className={`${styles.iconBtn} ${isDeafened ? styles.iconBtnDeafened : ''}`}
          onClick={onToggleDeafen}
          title={isDeafened ? 'Undeafen Audio' : 'Deafen Audio'}
          type="button"
        >
          <span
            className="material-symbols-outlined"
            style={{ fontSize: '20px', color: isDeafened ? 'var(--error)' : 'var(--on-surface-variant)' }}
          >
            {isDeafened ? 'headset_off' : 'headphones'}
          </span>
        </button>

        <div className={styles.dockDivider} />

        {/* Share Screen CTA */}
        <button
          className={`${styles.shareBtn} ${isSharing ? styles.shareBtnActive : ''}`}
          onClick={onToggleShare}
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
            {isSharing ? 'stop_screen_share' : 'screen_share'}
          </span>
          <span>{isSharing ? 'Stop Sharing' : 'Share Screen'}</span>
        </button>

        {/* View Mode Layout */}
        <button
          className={styles.modeBtn}
          onClick={onToggleLayout}
          title="Toggle Grid / Spotlight View"
          type="button"
        >
          <span className={`material-symbols-outlined ${styles.modeIcon}`} style={{ fontSize: '19px' }}>
            {isGridMode ? 'grid_view' : 'view_sidebar'}
          </span>
          <span>{isGridMode ? 'Grid View' : 'Spotlight'}</span>
        </button>

        {/* Voice & Video Settings */}
        <button
          className={styles.iconBtn}
          onClick={onOpenSettings}
          title="Voice & Video Settings"
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
            settings
          </span>
        </button>

        <div className={styles.dockDivider} />

        {/* Disconnect / Leave Hub */}
        <button
          className={styles.leaveBtn}
          onClick={onLeaveHub}
          title="Disconnect & Leave Room"
          type="button"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
            call_end
          </span>
        </button>
      </div>
    </footer>
  );
};
