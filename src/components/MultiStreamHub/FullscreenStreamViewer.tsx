import React, { useCallback, useEffect, useRef, useState } from 'react';
import styles from './FullscreenStreamViewer.module.css';
import { StreamItem } from '../../domain/dtos';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { getVolumeIcon, useAttachedVideoStream } from './StreamTile';

interface FullscreenStreamViewerProps {
  stream: StreamItem;
  mediaStream: MediaStream | null;
  onExitFullscreen: () => void | Promise<void>;
  onVolumeChange: (vol: number) => void;
}

export const FullscreenStreamViewer: React.FC<FullscreenStreamViewerProps> = ({
  stream,
  mediaStream,
  onExitFullscreen,
  onVolumeChange,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  useAttachedVideoStream(videoRef, mediaStream, stream.isLocal, stream.volume);

  const showControlsTemporarily = useCallback(() => {
    setControlsVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
    }
    hideTimerRef.current = window.setTimeout(() => {
      setControlsVisible(false);
    }, 2500);
  }, []);

  useEffect(() => {
    showControlsTemporarily();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
      }
    };
  }, [showControlsTemporarily]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      void onExitFullscreen();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExitFullscreen]);

  const handleToggleMute = (): void => {
    const nextVolume = stream.volume === 0 ? 100 : 0;
    onVolumeChange(nextVolume);
  };

  const avatarSrc = stream.avatarUrl || ELFY_MASCOT_ICON;

  return (
    <div
      className={`${styles.fullscreenContainer} ${!controlsVisible ? styles.cursorHidden : ''}`}
      data-testid="fullscreen-stream-viewer"
      onMouseMove={showControlsTemporarily}
      onDoubleClick={() => void onExitFullscreen()}
    >
      <div className={styles.fullscreenVideoArea}>
        {mediaStream && (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            disablePictureInPicture
            className={styles.fullscreenVideo}
          />
        )}
      </div>

      <div
        className={`${styles.controlsOverlay} ${controlsVisible ? styles.controlsVisible : styles.controlsHidden}`}
        onMouseMove={showControlsTemporarily}
      >
        <div className={styles.topBar} onDoubleClick={(e) => e.stopPropagation()}>
          <div className={styles.streamerInfo}>
            <div className={styles.streamerAvatarWrap}>
              <img src={avatarSrc} alt={stream.name} className={styles.streamerAvatar} />
              <span className={styles.liveDotSmall} />
            </div>
            <div className={styles.streamerMeta}>
              <span className={styles.streamerName}>{stream.name}</span>
              <div className={styles.liveBadge}>
                <span className={styles.pulseDot} />
                <span>LIVE</span>
              </div>
              <span className={styles.resTag}>
                {stream.resolution} • {stream.fps}fps
              </span>
            </div>
          </div>

          <div className={styles.topActions}>
            <button
              className={styles.exitFullscreenBtn}
              data-testid="exit-fullscreen-btn"
              onClick={() => void onExitFullscreen()}
              title="Exit Fullscreen (Esc)"
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                fullscreen_exit
              </span>
              <span>Exit Fullscreen</span>
              <span className={styles.escHint}>ESC</span>
            </button>
          </div>
        </div>

        {!stream.isLocal && (
          <div className={styles.bottomBar} onDoubleClick={(e) => e.stopPropagation()}>
            <div className={styles.volumeControl}>
              <button
                className={styles.volumeBtn}
                onClick={handleToggleMute}
                title={stream.volume === 0 ? 'Unmute' : 'Mute'}
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  {getVolumeIcon(stream.volume)}
                </span>
              </button>

              <input
                aria-label="Fullscreen stream volume"
                type="range"
                min="0"
                max="100"
                value={stream.volume}
                onChange={(e) => onVolumeChange(Number(e.target.value))}
                className={styles.volumeSlider}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FullscreenStreamViewer;
