import React, { useState } from 'react';
import styles from './FriendHubs.module.css';
import { FriendHub, UserProfile } from '../../types';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { hideMainWindowTauri, startDraggingTauri } from '../../utils/tauri';

interface FriendHubsProps {
  profile: UserProfile;
  hubs: FriendHub[];
  isSharing: boolean;
  onOpenHub: (hubId: string, autoStart: boolean) => void;
  onOpenProfile: () => void;
  onStopShare: () => void;
}

export const FriendHubs: React.FC<FriendHubsProps> = ({
  profile,
  isSharing,
  onOpenHub,
  onOpenProfile,
  onStopShare
}) => {
  const [hubs, setHubs] = useState<FriendHub[]>([]);
  const [copied, setCopied] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const myHub = `elfy/hub/${profile.nickname}${profile.peerTag}`;

  const handleCopyLink = () => {
    navigator.clipboard?.writeText(myHub).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleStopBroadcast = () => {
    if (window.confirm('Stop broadcasting screen to all active hubs?')) {
      onStopShare();
    }
  };

  const handleJoinByCode = (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!joinCode.trim()) return;


    const newHub: FriendHub = {
      id: joinCode.trim(),
      name: joinCode.trim(),
      status: 'idle',
      description: '',
      previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB4ADxW8ZnRZzNLCb1Y8iSB01mH-LJbcbQQw_sMRjD-q3nimRXiRmnNqdePhnrO_Hb9RNZXKD3DCVoQ4VRD3HDoEIrARON2pAPJu8Z5rQjW3lHApg0jWzNXMn0DEfheG_JTfFm4SuAexfX_BwVCy-OxRGjrq4M5WPmXi3N4zXtVCqFnZsWENgtAX7B5gyiTw-IbaAz9QAAMJUKPf5t5DMkm5vZ-jjWs3JGfw8yj5TMl18i0UtRCBv2HVw',
      peers: 1,
      latency: 19,
      audioFormat: 'Stereo 48kHz'
    };

    setHubs((prev) => [newHub, ...prev]);
    setJoinCode('');
  };

  const handleHideWindow = async () => {
    await hideMainWindowTauri();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    startDraggingTauri();
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.container}>
        {/* Companion Header (NO tab selector, NO mock mac dots) */}
        <header
          className={styles.header}
          onMouseDown={handleMouseDown}
        >
          <div className={styles.headerLeft}>
            <div className={styles.mascotLogo}>
              <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" />
            </div>
            <span className={styles.brandTitle}>Elfy</span>
          </div>

          <div className={styles.headerRight}>
            <div
              className={styles.profileAvatar}
              onClick={onOpenProfile}
              role="button"
              tabIndex={0}
              data-no-drag="true"
              title={`Edit Persona (${profile.nickname}${profile.peerTag})`}
            >
              <img src={profile.avatarUrl} alt={profile.nickname} />
            </div>

            <button
              className={styles.trayCloseBtn}
              onClick={handleHideWindow}
              title="Hide to system tray"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                close
              </span>
            </button>
          </div>
        </header>

        {/* Main Content Area */}
        <main className={styles.contentArea}>
          {/* Active Broadcasting Bento Card */}
          <div className={styles.broadcastingCard}>
            <div className={styles.ambientAura} />

            <div className={styles.heroTopRow}>
              <div className={styles.heroBadgeWrap}>
                <div className={styles.broadcastingPill}>
                  <div className={styles.pingWrap}>
                    <span className={styles.pingDotAnimate} />
                    <span className={styles.pingDotSolid} />
                  </div>
                  <span className={styles.broadcastingLabel}>
                    {!isSharing ? 'Idle' : 'Live'}
                  </span>
                </div>
                <span className={styles.peerTag}>{profile.nickname}{profile.peerTag}</span>
              </div>

              <div className={styles.heroControls}>
                <button
                  className={styles.heroBtnStop}
                  onClick={!isSharing ? () => onOpenHub(myHub, true) : handleStopBroadcast}
                  type="button"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                    {!isSharing ? "play_circle" : "stop_circle"}
                  </span>
                  <span>{!isSharing ? "Start" : "Stop"}</span>
                </button>
              </div>
            </div>

            {/* Center Data: Feed Specs & Equalizer */}
            <div className={styles.feedSpecsWrap}>
              <div className={styles.feedSpecsLeft}>
                <div className={styles.specIconBox}>
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                    screen_share
                  </span>
                </div>
                <div className={styles.specDetails}>
                  <span className={styles.specTitle}>Main Display + Audio</span>
                  <div className={styles.specSub}>
                    <span className={styles.specRose}>1080p · 60fps</span>
                    <span>·</span>
                    <span>Opus 128k</span>
                  </div>
                </div>
              </div>

              <div className={styles.meterWrap}>
                <div className={styles.equalizerBars}>
                  <span className={`${styles.bar} ${styles.bar1}`} />
                  <span className={`${styles.bar} ${styles.bar2}`} />
                  <span className={`${styles.bar} ${styles.bar3}`} />
                  <span className={`${styles.bar} ${styles.bar4}`} />
                  <span className={`${styles.bar} ${styles.bar5}`} />
                </div>
                <span className={styles.bitrateText}>5,840 kbps</span>
              </div>
            </div>

            {/* Quick Share Link Pill */}
            <div className={styles.shareLinkBar}>
              <div className={styles.shareLinkText}>
                <span className="material-symbols-outlined" style={{ fontSize: '14px', color: 'var(--primary)' }}>
                  link
                </span>
                <span>elfy/hub/{profile.nickname}{profile.peerTag}</span>
              </div>

              <button className={styles.copyPillBtn} onClick={handleCopyLink} type="button">
                <span className="material-symbols-outlined" style={{ fontSize: '13px' }}>
                  content_copy
                </span>
                <span>{copied ? 'Copied' : 'Copy'}</span>
              </button>
            </div>
          </div>

          {/* Join Another Hub by Code */}
          <form className={styles.joinCodeBox} onSubmit={handleJoinByCode}>
            <div className={styles.joinCodeHeader}>
              <span className={styles.joinCodeTitle}>
                <span className="material-symbols-outlined" style={{ fontSize: '15px', color: 'var(--primary)' }}>
                  add_circle
                </span>
                <span>Join Hub by Code</span>
              </span>
              <span className={styles.noSignupText}>No Signup</span>
            </div>

            <div className={styles.joinInputRow}>
              <div className={styles.joinInputWrap}>
                <span className={`material-symbols-outlined ${styles.joinTagIcon}`} style={{ fontSize: '14px' }}>
                  tag
                </span>
                <input
                  className={styles.joinInput}
                  type="text"
                  placeholder="e.g. elfy/hub/Beako#rByRBY"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                />
              </div>

              <button className={styles.joinSubmitBtn} type="submit">
                Join
              </button>
            </div>
          </form>

          {/* Friend Hubs List - Always opens a standalone resizable stream viewer window */}
          <div className={styles.hubsSection}>
            <div className={styles.hubsHeader}>
              <div className={styles.hubsTitleWrap}>
                <span className={styles.hubsTitle}>Your Friend Hubs</span>
                <span className={styles.hubsCountBadge}>{hubs.length} Active</span>
              </div>
              <span className={styles.p2pLabel}>P2P Mesh</span>
            </div>

            {hubs.map((hub) => (
              <div
                key={hub.id}
                className={`${styles.hubCard} ${hub.status === 'broadcasting' ? styles.hubCardActive : ''}`}
                onClick={() => onOpenHub(hub.id, false)}
                title={`Click to open ${hub.name} in standalone screen-sharing window`}
              >
                <div className={styles.hubTopRow}>
                  <div className={styles.hubInfoLeft}>
                    <div className={styles.hubThumbWrap}>
                      <img src={hub.previewImage} alt={hub.name} className={styles.hubThumb} />
                      <span
                        className={`${styles.hubOnlineDot} ${hub.status !== 'broadcasting' ? styles.hubOnlineDotCyan : ''}`}
                      />
                    </div>

                    <div className={styles.hubDetails}>
                      <div className={styles.hubNameRow}>
                        <span className={styles.hubName}>{hub.name}</span>
                        {hub.status === 'broadcasting' && (
                          <span className={styles.broadcastingSmallPill}>Live</span>
                        )}
                      </div>
                      <p className={styles.hubDesc}>{hub.description}</p>
                    </div>
                  </div>

                  <div className={styles.hubActions}>
                    {hub.status === 'broadcasting' ? (
                      <button
                        className={styles.connectedBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenHub(hub.id, false);
                        }}
                        type="button"
                      >
                        Watch
                      </button>
                    ) : (
                      <button
                        className={styles.castBtn}
                        onClick={(e) => {
                          e.stopPropagation();
                          onOpenHub(hub.id, false);
                        }}
                        type="button"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>
                          cast
                        </span>
                        <span>Open</span>
                      </button>
                    )}
                  </div>
                </div>

                {hub.status === 'broadcasting' && (
                  <div className={styles.hubSubBar}>
                    <span className={styles.spatialStereoTag}>
                      <span className="material-symbols-outlined" style={{ fontSize: '12px' }}>
                        graphic_eq
                      </span>
                      <span>Spatial Stereo · {hub.peers} peers</span>
                    </span>
                    <span className={styles.latencyTag}>
                      <span className={styles.latencyDot} />
                      <span>{hub.latency}ms</span>
                    </span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </main>

        {/* Companion Footer */}
        <footer className={styles.footer}>
          <div className={styles.footerLeft}>
            <span>v2.4.1 Companion</span>
            <span className={styles.footerLatency}>
              <span className="material-symbols-outlined" style={{ fontSize: '11px' }}>
                wifi_tethering
              </span>
              <span>18ms</span>
            </span>
          </div>

          <div className={styles.footerRight}>
            <button className={styles.footerBtn} onClick={onOpenProfile} type="button">
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>badge</span>
              <span>Profile</span>
            </button>
            <button className={styles.footerBtn} onClick={handleHideWindow} type="button">
              <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>visibility_off</span>
              <span>Hide</span>
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
};
