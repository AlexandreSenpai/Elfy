import React, { useRef, useEffect, useState, useCallback } from 'react';
import styles from './FullscreenStreamViewer.module.css';
import { StreamItem } from '../../types';

interface FullscreenStreamViewerProps {
  stream: StreamItem;
  mediaStream: MediaStream | null;
  onExitFullscreen: () => void;
  onVolumeChange: (vol: number) => void;
}

export const FullscreenStreamViewer: React.FC<FullscreenStreamViewerProps> = ({
  stream,
  mediaStream,
  onExitFullscreen,
  onVolumeChange
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hideTimerRef = useRef<number | null>(null);
  const [controlsVisible, setControlsVisible] = useState(true);

  // Hook up media stream to video element
  useEffect(() => {
    if (videoRef.current && mediaStream) {
      videoRef.current.srcObject = mediaStream;
      videoRef.current.play().catch(() => {});
    }
  }, [mediaStream]);

  // Reset inactivity timer on mouse move
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

  // Escape key exits fullscreen
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onExitFullscreen();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onExitFullscreen]);

  const handleDoubleClick = () => {
    onExitFullscreen();
  };

  const isMuted = stream.volume === 0;

  const handleToggleMute = () => {
    if (isMuted) {
      onVolumeChange(100);
    } else {
      onVolumeChange(0);
    }
  };

  return (
    <div
      className={`${styles.fullscreenContainer} ${!controlsVisible ? styles.cursorHidden : ''}`}
      onMouseMove={showControlsTemporarily}
      onDoubleClick={handleDoubleClick}
    >
      {/* 100vw x 100vh Video Display */}
      <div
        className={styles.fullscreenVideoArea}
        style={!mediaStream && stream.previewImage ? { backgroundImage: `url(${stream.previewImage})` } : undefined}
      >
        {mediaStream ? (
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted={stream.isLocal}
            disablePictureInPicture
            className={styles.fullscreenVideo}
          />
        ) : null}
      </div>

      {/* Floating Controls Overlay (Auto-hiding) */}
      <div
        className={`${styles.controlsOverlay} ${controlsVisible ? styles.controlsVisible : styles.controlsHidden}`}
        onMouseMove={showControlsTemporarily}
      >
        {/* Top Floating Bar */}
        <div className={styles.topBar}>
          <div className={styles.streamerInfo}>
            <div className={styles.streamerAvatarWrap}>
              <img src={stream.avatarUrl} alt={stream.name} className={styles.streamerAvatar} />
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
              onClick={onExitFullscreen}
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

        {/* Bottom Floating Bar */}
        <div className={styles.bottomBar}>
          <div className={styles.volumeControl}>
            <button
              className={styles.volumeBtn}
              onClick={handleToggleMute}
              title={isMuted ? 'Unmute' : 'Mute'}
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                {isMuted ? 'volume_off' : stream.volume < 50 ? 'volume_down' : 'volume_up'}
              </span>
            </button>

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
