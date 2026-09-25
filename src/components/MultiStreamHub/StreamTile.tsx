import React, { useRef, useEffect } from 'react';
import styles from './StreamTile.module.css';
import { StreamItem } from '../../types';
import { toggleFullscreenTauri } from '../../utils/tauri';

interface StreamTileProps {
  stream: StreamItem;
  isSpotlight: boolean;
  onToggleSpotlight: () => void;
  onVolumeChange: (vol: number) => void;
  onToggleFullscreen?: () => void;
  mediaStream?: MediaStream | null;
}

export const StreamTile: React.FC<StreamTileProps> = ({
  stream,
  isSpotlight,
  onToggleSpotlight,
  onVolumeChange,
  onToggleFullscreen,
  mediaStream
}) => {
  const tileRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
      videoRef.current.play().catch(() => {});
    }
  }, [mediaStream]);

  const handleFullscreenClick = async () => {
    if (onToggleFullscreen) {
      onToggleFullscreen();
    } else {
      if (!isSpotlight) {
        onToggleSpotlight();
      }
      await toggleFullscreenTauri();
    }
  };

  return (
    <div
      ref={tileRef}
      className={`${styles.tile} ${isSpotlight ? styles.spotlighted : ''}`}
    >
      {/* Video Content */}
      <div
        className={styles.videoArea}
        style={!mediaStream && stream.previewImage ? { backgroundImage: `url(${stream.previewImage})` } : undefined}
      >
        {mediaStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={stream.isLocal}
            disablePictureInPicture
            className={styles.realVideo}
          />
        ) : (
          <div className={styles.videoGradientOverlay} />
        )}

        {/* Top Overlay: Live badge, Spotlight & Fullscreen */}
        <div className={styles.topOverlay}>
          <div className={styles.livePill}>
            <span className={styles.liveDot} />
            <span className={styles.liveText}>LIVE</span>
            <span className={styles.bullet}>•</span>
            <span className={styles.resText}>
              {stream.resolution} {stream.fps}fps
            </span>
          </div>

          <div className={styles.topActions}>
            <button
              className={`${styles.actionBtn} ${isSpotlight ? styles.actionBtnActive : ''}`}
              onClick={onToggleSpotlight}
              title={isSpotlight ? 'Exit Spotlight' : 'Focus this stream'}
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                center_focus_strong
              </span>
            </button>

            <button
              className={styles.actionBtn}
              onClick={handleFullscreenClick}
              title="Fullscreen"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                fullscreen
              </span>
            </button>
          </div>
        </div>

        {/* Bottom Overlay: Streamer info & Volume */}
        <div className={styles.bottomOverlay}>
          <div className={styles.streamerTag}>
            <div className={styles.streamerAvatarWrap}>
              <img src={stream.avatarUrl} alt={stream.name} className={styles.streamerAvatar} />
              <span className={styles.avatarDot} />
            </div>
            <span className={styles.streamerName}>{stream.name}</span>
            <span className={styles.categoryPill}>{stream.tag}</span>
          </div>

          <div className={styles.volumeWrap}>
            <span className={`material-symbols-outlined ${styles.volumeIcon}`}>
              {stream.volume === 0 ? 'volume_off' : stream.volume < 50 ? 'volume_down' : 'volume_up'}
            </span>
            <input
              type="range"
              min="0"
              max="100"
              value={stream.volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className={styles.volumeSlider}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
