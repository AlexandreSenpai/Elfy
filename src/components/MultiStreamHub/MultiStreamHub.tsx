import React, { useState } from 'react';
import styles from './MultiStreamHub.module.css';
import { StreamItem, UserProfile } from '../../types';
import { StreamTile } from './StreamTile';
import { BottomDock } from './BottomDock';
import { ELFY_MASCOT_ICON } from '../../data/mockData';

interface MultiStreamHubProps {
  streams: StreamItem[];
  profile: UserProfile;
  mediaStream: MediaStream | null;
  isSharing: boolean;
  onStartShare: () => Promise<void>;
  onStopShare: () => void;
  onUpdateVolume: (id: string, vol: number) => void;
  remoteStream?: MediaStream | null;
  onToggleFullscreen?: (streamId: string) => void;
  onLeaveHubToFriendHubs?: () => void;
}

export const MultiStreamHub: React.FC<MultiStreamHubProps> = ({
  streams,
  mediaStream,
  remoteStream,
  isSharing,
  onStartShare,
  onStopShare,
  onUpdateVolume,
  onToggleFullscreen
}) => {
  const [isGridMode, setIsGridMode] = useState(true);
  const [spotlightIndex, setSpotlightIndex] = useState(0);
  const [isDeafened, setIsDeafened] = useState(false);
  const [isLeft, setIsLeft] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);

  const handleToggleLayout = () => {
    setIsGridMode((prev) => !prev);
  };

  const handleToggleSpotlight = (index: number) => {
    if (!isGridMode && spotlightIndex === index) {
      setIsGridMode(true);
    } else {
      setSpotlightIndex(index);
      setIsGridMode(false);
    }
  };

  const handleToggleShare = () => {
    onStartShare().catch(console.error);
  };

  const handleLeaveHub = () => {
    if (window.confirm('Leave The Treehouse screen share hub?')) {
      if (isSharing) {
        onStopShare();
      }
      setIsLeft(true);
    }
  };

  const handleRejoin = () => {
    setIsLeft(false);
  };

  if (isLeft) {
    return (
      <div className={styles.leftHubContainer}>
        <div className={styles.leftHubMascotWrap}>
          <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" className={styles.leftHubMascotImg} />
        </div>
        <h1 className={styles.leftHubTitle}>You left The Treehouse</h1>
        <p className={styles.leftHubSubtitle}>
          Ready whenever you want to re-join your friends in the multi-stream hub.
        </p>
        <button className={styles.rejoinBtn} onClick={handleRejoin} type="button">
          Re-join Hub
        </button>
      </div>
    );
  }

  const spotlightStream = streams[spotlightIndex] || streams[0];
  const sideStreams = streams.filter((_, idx) => idx !== spotlightIndex);

  const getStreamMedia = (s: StreamItem) => {
    if (s.isLocal) return mediaStream;
    if (s.id === 'remote-peer-stream' || s.id.startsWith('peer-')) return remoteStream || s.mediaStream || null;
    return s.mediaStream || null;
  };

  return (
    <>
      <main className={styles.mainCanvas}>
        {isGridMode ? (
          <div className={styles.streamsGrid}>
            {streams.map((stream, idx) => (
              <StreamTile
                key={stream.id}
                stream={stream}
                isSpotlight={false}
                onToggleSpotlight={() => handleToggleSpotlight(idx)}
                onVolumeChange={(vol) => onUpdateVolume(stream.id, vol)}
                onToggleFullscreen={() => onToggleFullscreen?.(stream.id)}
                mediaStream={getStreamMedia(stream)}
              />
            ))}
          </div>
        ) : (
          <div className={styles.spotlightLayout}>
            {/* Main Spotlight View */}
            <div className={styles.spotlightMain}>
              <StreamTile
                stream={spotlightStream}
                isSpotlight={true}
                onToggleSpotlight={() => setIsGridMode(true)}
                onVolumeChange={(vol) => onUpdateVolume(spotlightStream.id, vol)}
                onToggleFullscreen={() => onToggleFullscreen?.(spotlightStream.id)}
                mediaStream={getStreamMedia(spotlightStream)}
              />
            </div>

            {/* Side Thumbnails */}
            <div className={styles.spotlightSidebar}>
              {sideStreams.map((stream) => {
                const actualIdx = streams.findIndex((s) => s.id === stream.id);
                return (
                  <StreamTile
                    key={stream.id}
                    stream={stream}
                    isSpotlight={false}
                    onToggleSpotlight={() => handleToggleSpotlight(actualIdx)}
                    onVolumeChange={(vol) => onUpdateVolume(stream.id, vol)}
                    onToggleFullscreen={() => onToggleFullscreen?.(stream.id)}
                    mediaStream={getStreamMedia(stream)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </main>

      {/* Floating Bottom Dock */}
      <BottomDock
        isDeafened={isDeafened}
        onToggleDeafen={() => setIsDeafened((prev) => !prev)}
        isSharing={isSharing}
        onToggleShare={handleToggleShare}
        isGridMode={isGridMode}
        onToggleLayout={handleToggleLayout}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onLeaveHub={handleLeaveHub}
      />

      {/* Voice & Video Settings Modal */}
      {isSettingsOpen && (
        <div className={styles.modalBackdrop} onClick={() => setIsSettingsOpen(false)}>
          <div className={styles.modalContent} onClick={(e) => e.stopPropagation()}>
            <div className={styles.modalHeader}>
              <h3 className={styles.modalTitle}>Voice &amp; Video Settings</h3>
              <button
                className={styles.closeModalBtn}
                onClick={() => setIsSettingsOpen(false)}
                type="button"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>

            <div className={styles.settingRow}>
              <label className={styles.settingLabel}>Input Device (Microphone)</label>
              <select className={styles.settingSelect} defaultValue="default">
                <option value="default">Default - System High Definition Audio</option>
                <option value="comms">Communications Microphone</option>
              </select>
            </div>

            <div className={styles.settingRow}>
              <label className={styles.settingLabel}>Output Device (Headphones)</label>
              <select className={styles.settingSelect} defaultValue="default">
                <option value="default">Default - Realtek High Definition Audio</option>
                <option value="spatial">Spatial Stereo Headphones (Opus 128kbps)</option>
              </select>
            </div>

            <div className={styles.settingRow}>
              <label className={styles.settingLabel}>Capture Quality</label>
              <select className={styles.settingSelect} defaultValue="1080p60">
                <option value="1080p60">1080p @ 60fps (Recommended)</option>
                <option value="1440p60">1440p @ 60fps (High Bitrate)</option>
                <option value="720p30">720p @ 30fps (Low Latency)</option>
              </select>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
