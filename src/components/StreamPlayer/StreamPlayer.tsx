import React, { useRef, useEffect, useState } from 'react';
import styles from './StreamPlayer.module.css';
import { isTauri, toggleFullscreenTauri } from '../../utils/tauri';

export interface StreamPlayerProps {
  mediaStream: MediaStream | null;
  isLocal?: boolean;
  streamerName?: string;
  streamerAvatar?: string;
  isLive?: boolean;
  resolution?: string;
  fps?: number;
  emptyState?: React.ReactNode;
  controls?: React.ReactNode;
  onToggleFullscreen?: () => void;
}

export const StreamPlayer: React.FC<StreamPlayerProps> = ({
  mediaStream,
  isLocal = false,
  streamerName = 'Streamer',
  streamerAvatar,
  isLive = false,
  resolution = '1080p',
  fps = 60,
  emptyState,
  controls,
  onToggleFullscreen,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [volume, setVolume] = useState<number>(100);
  const [isMuted, setIsMuted] = useState<boolean>(isLocal);

  // Attach tracks and listen for track updates
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (mediaStream) {
      videoEl.srcObject = mediaStream;
      videoEl.play().catch((err) => {
        console.warn('[StreamPlayer] Auto-play prevented or awaiting interaction:', err);
      });

      const handleTracksChange = () => {
        videoEl.srcObject = mediaStream;
        videoEl.play().catch(() => {});
      };

      mediaStream.addEventListener('addtrack', handleTracksChange);
      mediaStream.addEventListener('removetrack', handleTracksChange);

      return () => {
        mediaStream.removeEventListener('addtrack', handleTracksChange);
        mediaStream.removeEventListener('removetrack', handleTracksChange);
      };
    } else {
      videoEl.srcObject = null;
    }
  }, [mediaStream]);

  // Handle volume and mute
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (isLocal) {
      videoEl.muted = true;
    } else {
      videoEl.muted = isMuted;
      videoEl.volume = volume / 100;
    }
  }, [isLocal, isMuted, volume]);

  const handleToggleMute = () => {
    if (isLocal) return;
    setIsMuted((prev) => !prev);
  };

  const handleFullscreenClick = async () => {
    if (onToggleFullscreen) {
      onToggleFullscreen();
      return;
    }

    if (isTauri()) {
      await toggleFullscreenTauri();
    } else if (containerRef.current) {
      if (!document.fullscreenElement) {
        await containerRef.current.requestFullscreen();
      } else {
        await document.exitFullscreen();
      }
    }
  };

  if (!mediaStream && emptyState) {
    return <div className={styles.emptyWrapper}>{emptyState}</div>;
  }

  return (
    <div ref={containerRef} className={styles.playerContainer}>
      <div className={styles.videoArea}>
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted={isLocal}
          disablePictureInPicture
          className={styles.realVideo}
        />

        {/* Top Overlay: Live status badge & actions */}
        <div className={styles.topOverlay}>
          <div className={styles.livePill}>
            <span className={styles.liveDot} />
            <span className={styles.liveText}>{isLive ? 'LIVE' : 'STANDBY'}</span>
            <span className={styles.bullet}>•</span>
            <span className={styles.resText}>
              {resolution} {fps}fps
            </span>
          </div>

          <div className={styles.topActions}>
            {controls}
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

        {/* Bottom Overlay: Streamer info & volume control */}
        <div className={styles.bottomOverlay}>
          <div className={styles.streamerTag}>
            <div className={styles.streamerAvatarWrap}>
              {streamerAvatar ? (
                <img src={streamerAvatar} alt={streamerName} className={styles.streamerAvatar} />
              ) : (
                <span className={`material-symbols-outlined ${styles.avatarFallback}`}>person</span>
              )}
            </div>
            <span className={styles.streamerName}>{streamerName}</span>
            <span className={styles.categoryPill}>{isLocal ? 'Your Stream' : 'Live Broadcast'}</span>
          </div>

          {!isLocal && (
            <div className={styles.volumeWrap}>
              <button
                className={styles.volumeBtn}
                onClick={handleToggleMute}
                title={isMuted ? 'Unmute' : 'Mute'}
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  {isMuted || volume === 0
                    ? 'volume_off'
                    : volume < 50
                    ? 'volume_down'
                    : 'volume_up'}
                </span>
              </button>
              <input
                type="range"
                min="0"
                max="100"
                value={isMuted ? 0 : volume}
                onChange={(e) => {
                  setVolume(Number(e.target.value));
                  if (isMuted) setIsMuted(false);
                }}
                className={styles.volumeSlider}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StreamPlayer;
