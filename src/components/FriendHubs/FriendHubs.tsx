import React, { useState } from 'react';
import styles from './FriendHubs.module.css';
import { ActiveMinimizedHubDto, FriendHubViewModel, HubLiveState, UserProfile } from '../../domain/dtos';
import { sanitizeHubCode } from '../../domain/validators';
import { formatFullPeerTag } from '../../utils/hubTopics';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { beginWindowDragOnMove, hideMainWindowTauri, isTauri, quitAppTauri } from '../../utils/tauri';
import { DockContextMenu, useDockContextMenu } from '../DockContextMenu/DockContextMenu';

interface FriendHubsProps {
  profile: UserProfile;
  isProfileLoading: boolean;
  hubs: FriendHubViewModel[];
  isProbing: boolean;
  minimizedHub: ActiveMinimizedHubDto | null;
  onOpenHub: (hubId: string, autoStart?: boolean) => void | Promise<void>;
  onOpenProfile: () => void | Promise<void>;
  onRefreshHubs: () => void | Promise<void>;
  onRemoveHub: (hubId: string) => void | Promise<void>;
  onRestoreMinimizedHub: () => void | Promise<void>;
  onDisconnectMinimizedHub: () => void | Promise<void>;
}

interface HubStatusDisplay {
  label: string;
  actionLabel: string;
  badgeClass: string;
  dotClass: string;
}

const HUB_STATUS_META: Record<HubLiveState, HubStatusDisplay> = {
  broadcasting: {
    label: 'Broadcasting',
    actionLabel: 'Watch',
    badgeClass: styles.statusBroadcasting,
    dotClass: styles.hubDotBroadcasting,
  },
  online: {
    label: 'Online',
    actionLabel: 'Join',
    badgeClass: styles.statusOnline,
    dotClass: styles.hubDotOnline,
  },
  offline: {
    label: 'Offline',
    actionLabel: 'Open',
    badgeClass: styles.statusOffline,
    dotClass: styles.hubDotOffline,
  },
};

const formatStreamersSummary = (hub: FriendHubViewModel): string => {
  if (hub.streamerNames.length > 0) {
    return `Streaming: ${hub.streamerNames.join(', ')}`;
  }
  if (hub.status === 'online') {
    return 'Room open · Ready to watch or share';
  }
  return `${hub.ownerNickname}${hub.ownerTag} · Knock when host is online`;
};

export const FriendHubs: React.FC<FriendHubsProps> = ({
  profile,
  isProfileLoading,
  hubs,
  isProbing,
  minimizedHub,
  onOpenHub,
  onOpenProfile,
  onRefreshHubs,
  onRemoveHub,
  onRestoreMinimizedHub,
  onDisconnectMinimizedHub,
}) => {
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinError, setJoinError] = useState<string | null>(null);
  const { menuPosition, closeMenu, handleDockContextMenu } = useDockContextMenu();

  const fullTag = formatFullPeerTag(profile.nickname, profile.peerTag);
  const myHub = `elfy/hub/${fullTag}`;
  const activeHubsCount = hubs.filter((item) => item.status !== 'offline').length;

  const handleCopyLink = (): void => {
    if (isProfileLoading) return;
    navigator.clipboard?.writeText(myHub).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };

  const handleJoinByCode = (e: React.FormEvent): void => {
    e.preventDefault();
    const sanitized = sanitizeHubCode(joinCode);
    if (!sanitized) {
      setJoinError('Enter a valid Hub ID like elfy/hub/#a1b2c3d4e5');
      return;
    }

    setJoinError(null);
    setJoinCode('');
    void onOpenHub(sanitized, false);
  };

  const handleHideWindow = async (): Promise<void> => {
    if (!isTauri()) return;
    await hideMainWindowTauri();
  };

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    beginWindowDragOnMove(e.clientX, e.clientY);
  };

  const renderHubCard = (hub: FriendHubViewModel) => {
    const statusMeta = HUB_STATUS_META[hub.status];
    const isLive = hub.status === 'broadcasting';
    const avatarSrc = hub.ownerAvatar || ELFY_MASCOT_ICON;

    return (
      <div
        key={hub.hubId}
        className={`${styles.hubCard} ${isLive ? styles.hubCardActive : ''}`}
        data-testid="friend-hub-card"
        onClick={() => void onOpenHub(hub.hubId, false)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            void onOpenHub(hub.hubId, false);
          }
        }}
        title={`Open ${hub.ownerNickname}${hub.ownerTag}`}
      >
        <div className={styles.hubTopRow}>
          <div className={styles.hubInfoLeft}>
            <div className={styles.hubThumbWrap}>
              <img src={avatarSrc} alt={hub.ownerNickname} className={styles.hubThumb} />
              <span className={`${styles.hubOnlineDot} ${statusMeta.dotClass}`} />
            </div>

            <div className={styles.hubDetails}>
              <div className={styles.hubNameRow}>
                <span className={styles.hubName}>
                  {hub.ownerNickname}
                  <span className={styles.hubOwnerTag}>{hub.ownerTag}</span>
                </span>
                <span className={`${styles.statusBadge} ${statusMeta.badgeClass}`}>
                  {statusMeta.label}
                </span>
              </div>
              <p className={styles.hubDesc}>{formatStreamersSummary(hub)}</p>
            </div>
          </div>

          <div className={styles.hubActions}>
            <button
              className={isLive ? styles.connectedBtn : styles.castBtn}
              onClick={(e) => {
                e.stopPropagation();
                void onOpenHub(hub.hubId, false);
              }}
              type="button"
            >
              <span>{statusMeta.actionLabel}</span>
            </button>

            <button
              aria-label={`Remove ${hub.ownerNickname}`}
              className={styles.removeHubBtn}
              onClick={(e) => {
                e.stopPropagation();
                void onRemoveHub(hub.hubId);
              }}
              title="Remove Friend Hub"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                close
              </span>
            </button>
          </div>
        </div>

        <div className={styles.hubSubBar}>
          <span className={styles.peerCountTag} data-testid="hub-peer-count">
            <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>
              group
            </span>
            <span>{hub.peers} {hub.peers === 1 ? 'peer' : 'peers'}</span>
          </span>
          <span className={styles.latencyTag}>
            <span className={styles.latencyDot} />
            <span>{hub.status !== 'offline' && hub.latencyMs > 0 ? `${hub.latencyMs}ms` : 'Standby'}</span>
          </span>
        </div>
      </div>
    );
  };

  return (
    <div className={styles.wrapper}>
      <DockContextMenu position={menuPosition} onClose={closeMenu} />
      <div className={styles.container}>
        <header
          className={styles.header}
          onContextMenu={handleDockContextMenu}
          onMouseDown={handleMouseDown}
        >
          <div
            className={styles.headerLeft}
            data-testid="dock-brand-trigger"
            title="Right-click for Elfy options"
          >
            <div className={styles.mascotLogo}>
              <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" />
            </div>
            <span className={styles.brandTitle}>Elfy</span>
          </div>

          <div className={styles.headerRight}>
            <button
              aria-label={`Edit Persona (${fullTag})`}
              className={styles.profileAvatarBtn}
              data-no-drag="true"
              onClick={() => void onOpenProfile()}
              title={`Edit Persona (${fullTag})`}
              type="button"
            >
              <img src={profile.avatarUrl} alt={profile.nickname} />
            </button>

            {isTauri() && (
              <button
                className={styles.trayCloseBtn}
                onClick={() => void handleHideWindow()}
                title="Hide to system tray"
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  close
                </span>
              </button>
            )}
          </div>
        </header>

        <main className={styles.contentArea}>
          <div className={styles.contentInner}>
            {minimizedHub && (
              <section className={styles.minimizedBanner} data-testid="minimized-hub-banner">
                <div className={styles.minimizedInfo}>
                  <div className={styles.minimizedTitleRow}>
                    <span className={styles.minimizedPulseDot} />
                    <span className={styles.minimizedTitle}>Active Hub Connected</span>
                  </div>
                  <span className={styles.minimizedMeta}>
                    {minimizedHub.hubId} · {minimizedHub.activeStreamsCount} streams ·{' '}
                    {minimizedHub.isSharing ? 'Sharing' : 'Watching'}
                  </span>
                </div>

                <div className={styles.minimizedActions}>
                  <button
                    className={styles.restoreBannerBtn}
                    data-testid="restore-hub-btn"
                    onClick={() => void onRestoreMinimizedHub()}
                    type="button"
                  >
                    Return to Room
                  </button>
                  <button
                    className={styles.disconnectBannerBtn}
                    data-testid="leave-minimized-hub-btn"
                    onClick={() => void onDisconnectMinimizedHub()}
                    type="button"
                  >
                    Disconnect
                  </button>
                </div>
              </section>
            )}

            <section className={styles.broadcastingCard}>
              <div className={styles.ambientAura} />

              <div className={styles.heroTopRow}>
                <div className={styles.heroBadgeWrap}>
                  <div className={styles.broadcastingPill}>
                    <div className={styles.pingWrap}>
                      <span className={styles.pingDotAnimate} />
                      <span className={styles.pingDotSolid} />
                    </div>
                    <span className={styles.broadcastingLabel}>My Hub</span>
                  </div>
                  <span className={styles.peerTag}>
                    {isProfileLoading ? 'Loading...' : `${profile.nickname} (${fullTag})`}
                  </span>
                </div>

                <button
                  className={styles.openHubBtn}
                  data-testid="open-my-hub-btn"
                  disabled={isProfileLoading}
                  onClick={() => void onOpenHub(myHub, false)}
                  type="button"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '15px' }}>
                    meeting_room
                  </span>
                  <span>Open Room</span>
                </button>
              </div>

              <div className={styles.shareLinkBar}>
                <div className={styles.shareLinkText}>
                  <span className="material-symbols-outlined" style={{ fontSize: '14px', color: 'var(--primary)', flexShrink: 0 }}>
                    link
                  </span>
                  {isProfileLoading ? (
                    <span>Loading hub ID...</span>
                  ) : (
                    <span className={styles.shareLinkCode} data-testid="my-hub-code">
                      {myHub}
                    </span>
                  )}
                </div>

                <button
                  className={styles.copyPillBtn}
                  disabled={isProfileLoading}
                  onClick={handleCopyLink}
                  type="button"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>
                    content_copy
                  </span>
                  <span>{copied ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
            </section>

            <form className={styles.joinCodeBox} onSubmit={handleJoinByCode}>
              <div className={styles.joinCodeHeader}>
                <span className={styles.joinCodeTitle}>
                  <span className="material-symbols-outlined" style={{ fontSize: '15px', color: 'var(--primary)' }}>
                    add_circle
                  </span>
                  <span>Join a Hub</span>
                </span>
              </div>

              <div className={styles.joinInputRow}>
                <div className={styles.joinInputWrap}>
                  <span className={`material-symbols-outlined ${styles.joinTagIcon}`} style={{ fontSize: '14px' }}>
                    tag
                  </span>
                  <input
                    className={styles.joinInput}
                    data-testid="join-hub-input"
                    type="text"
                    placeholder="e.g. elfy/hub/#a1b2c3d4e5"
                    value={joinCode}
                    onChange={(e) => {
                      setJoinError(null);
                      setJoinCode(e.target.value);
                    }}
                  />
                </div>

                <button className={styles.joinSubmitBtn} data-testid="join-hub-submit" type="submit">
                  Join
                </button>
              </div>

              {joinError && <span className={styles.joinErrorText}>{joinError}</span>}
            </form>

            <section className={styles.hubsSection}>
              <div className={styles.hubsHeader}>
                <div className={styles.hubsTitleWrap}>
                  <span className={styles.hubsTitle}>Saved Friend Hubs</span>
                  <span className={styles.hubsCountBadge}>{activeHubsCount} Live</span>
                </div>

                <button
                  className={styles.refreshBtn}
                  data-testid="refresh-hubs-btn"
                  disabled={isProbing}
                  onClick={() => void onRefreshHubs()}
                  title="Check friend hubs"
                  type="button"
                >
                  <span
                    className={`material-symbols-outlined ${isProbing ? styles.spinIcon : ''}`}
                    style={{ fontSize: '14px' }}
                  >
                    refresh
                  </span>
                  <span>{isProbing ? 'Checking...' : 'Refresh'}</span>
                </button>
              </div>

              <div className={styles.hubsList} data-testid="friend-hubs-list">
                {hubs.length === 0 ? (
                  <div className={styles.emptyHubsCard}>
                    <span className="material-symbols-outlined" style={{ fontSize: '22px', color: 'var(--on-surface-muted)' }}>
                      groups
                    </span>
                    <p>Enter a friend&apos;s Hub ID above to connect and save it to your list.</p>
                  </div>
                ) : (
                  hubs.map(renderHubCard)
                )}
              </div>
            </section>
          </div>
        </main>

        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            <span>
              {hubs.length} Saved {hubs.length === 1 ? 'Hub' : 'Hubs'}
            </span>
          </div>

          <div className={styles.footerRight}>
            <button className={styles.footerBtn} onClick={() => void onOpenProfile()} type="button">
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                badge
              </span>
              <span>Profile</span>
            </button>
            {isTauri() && (
              <>
                <button className={styles.footerBtn} onClick={() => void handleHideWindow()} type="button">
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                    visibility_off
                  </span>
                  <span>Hide</span>
                </button>
                <button
                  className={styles.footerBtn}
                  data-testid="quit-elfy-footer-btn"
                  onClick={() => void quitAppTauri()}
                  title="Close Elfy Completely"
                  type="button"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                    power_settings_new
                  </span>
                  <span>Quit</span>
                </button>
              </>
            )}
          </div>
        </footer>
      </div>
    </div>
  );
};

export default FriendHubs;
