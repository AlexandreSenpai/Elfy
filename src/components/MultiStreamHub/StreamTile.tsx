import React, { useEffect, useRef } from 'react';
import styles from './StreamTile.module.css';
import { StreamItem } from '../../domain/dtos';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { toggleFullscreenTauri } from '../../utils/tauri';

interface StreamTileProps {
  stream: StreamItem;
  isSpotlight: boolean;
  onToggleSpotlight: () => void;
  onVolumeChange: (vol: number) => void;
  onToggleFullscreen?: () => void;
  mediaStream?: MediaStream | null;
}

const getVolumeIcon = (volume: number): string => {
  if (volume === 0) return 'volume_off';
  if (volume < 50) return 'volume_down';
  return 'volume_up';
};

export const StreamTile: React.FC<StreamTileProps> = ({
  stream,
  isSpotlight,
  onToggleSpotlight,
  onVolumeChange,
  onToggleFullscreen,
  mediaStream,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (!mediaStream) {
      videoEl.srcObject = null;
      return;
    }

    const syncPlayback = (): void => {
      videoEl.srcObject = mediaStream;
      videoEl.play().catch(() => {});
    };

    syncPlayback();
    mediaStream.addEventListener('addtrack', syncPlayback);
    mediaStream.addEventListener('removetrack', syncPlayback);

    return () => {
      mediaStream.removeEventListener('addtrack', syncPlayback);
      mediaStream.removeEventListener('removetrack', syncPlayback);
      videoEl.srcObject = null;
    };
  }, [mediaStream]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    videoEl.muted = stream.isLocal || stream.volume === 0;
    videoEl.volume = Math.max(0, Math.min(1, stream.volume / 100));
  }, [stream.isLocal, stream.volume]);

  const handleFullscreenClick = async (): Promise<void> => {
    if (onToggleFullscreen) {
      onToggleFullscreen();
      return;
    }
    if (!isSpotlight) {
      onToggleSpotlight();
    }
    await toggleFullscreenTauri();
  };

  const avatarSrc = stream.avatarUrl || ELFY_MASCOT_ICON;

  return (
    <div
      className={`${styles.tile} ${isSpotlight ? styles.spotlighted : ''}`}
      data-testid="stream-tile"
      onDoubleClick={() => void handleFullscreenClick()}
    >
      <div className={styles.videoArea}>
        {mediaStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={stream.isLocal || stream.volume === 0}
            disablePictureInPicture
            className={styles.realVideo}
          />
        ) : (
          <div className={styles.videoGradientOverlay} />
        )}

        <div className={styles.topOverlay} onDoubleClick={(e) => e.stopPropagation()}>
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
              data-testid="enter-fullscreen-btn"
              onClick={() => void handleFullscreenClick()}
              title="Fullscreen"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                fullscreen
              </span>
            </button>
          </div>
        </div>

        <div className={styles.bottomOverlay} onDoubleClick={(e) => e.stopPropagation()}>
          <div className={styles.streamerTag}>
            <div className={styles.streamerAvatarWrap}>
              <img src={avatarSrc} alt={stream.name} className={styles.streamerAvatar} />
              <span className={styles.avatarDot} />
            </div>
            <span className={styles.streamerName}>{stream.name}</span>
            <span className={styles.categoryPill}>{stream.tag}</span>
          </div>

          {!stream.isLocal && (
            <div className={styles.volumeWrap}>
              <span className={`material-symbols-outlined ${styles.volumeIcon}`}>
                {getVolumeIcon(stream.volume)}
              </span>
              <input
                aria-label={`Volume for ${stream.name}`}
                type="range"
                min="0"
                max="100"
                value={stream.volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                className={styles.volumeSlider}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default StreamTile;
