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

export const getVolumeIcon = (volume: number): string => {
  if (volume === 0) return 'volume_off';
  if (volume < 50) return 'volume_down';
  return 'volume_up';
};

export const useAttachedVideoStream = (
  videoRef: React.RefObject<HTMLVideoElement | null>,
  mediaStream: MediaStream | null | undefined,
  isLocal: boolean,
  volume: number
): void => {
  const shouldMuteRef = useRef<boolean>(isLocal || volume === 0);
  const volumeRef = useRef<number>(Math.max(0, Math.min(1, volume / 100)));
  const autoplayMutedRef = useRef<boolean>(false);

  shouldMuteRef.current = isLocal || volume === 0;
  volumeRef.current = Math.max(0, Math.min(1, volume / 100));

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    if (!mediaStream) {
      videoEl.srcObject = null;
      autoplayMutedRef.current = false;
      return;
    }

    let disposed = false;
    let boundTracks: MediaStreamTrack[] = [];
    let detachGestureUnlock: (() => void) | null = null;

    const removeGestureUnlock = (): void => {
      if (!detachGestureUnlock) return;
      detachGestureUnlock();
      detachGestureUnlock = null;
    };

    const ensureGestureUnlock = (): void => {
      if (detachGestureUnlock || shouldMuteRef.current) return;

      const unlockAudio = (): void => {
        removeGestureUnlock();
        autoplayMutedRef.current = false;
        if (disposed || shouldMuteRef.current) return;
        videoEl.muted = false;
        videoEl.volume = volumeRef.current;
        void videoEl.play().catch(() => {});
      };

      window.addEventListener('pointerdown', unlockAudio, { capture: true, once: true });
      window.addEventListener('keydown', unlockAudio, { capture: true, once: true });
      detachGestureUnlock = () => {
        window.removeEventListener('pointerdown', unlockAudio, { capture: true });
        window.removeEventListener('keydown', unlockAudio, { capture: true });
      };
    };

    const syncPlayback = async (): Promise<void> => {
      if (disposed) return;
      if (videoEl.srcObject !== mediaStream) {
        videoEl.srcObject = mediaStream;
      }

      const wantMuted = shouldMuteRef.current || autoplayMutedRef.current;
      videoEl.muted = wantMuted;
      videoEl.volume = volumeRef.current;

      try {
        await videoEl.play();
      } catch {
        if (disposed || wantMuted) return;
        autoplayMutedRef.current = true;
        videoEl.muted = true;
        ensureGestureUnlock();
        await videoEl.play().catch(() => {});
      }
    };

    const handleReady = (): void => {
      void syncPlayback();
    };

    const rebindTrackUnmuteListeners = (): void => {
      for (const track of boundTracks) {
        track.removeEventListener('unmute', handleReady);
      }
      boundTracks = mediaStream.getTracks();
      for (const track of boundTracks) {
        track.addEventListener('unmute', handleReady);
      }
    };

    const handleTracksChanged = (): void => {
      rebindTrackUnmuteListeners();
      void syncPlayback();
    };

    rebindTrackUnmuteListeners();
    void syncPlayback();

    mediaStream.addEventListener('addtrack', handleTracksChanged);
    mediaStream.addEventListener('removetrack', handleTracksChanged);
    videoEl.addEventListener('loadedmetadata', handleReady);
    videoEl.addEventListener('canplay', handleReady);

    return () => {
      disposed = true;
      removeGestureUnlock();
      mediaStream.removeEventListener('addtrack', handleTracksChanged);
      mediaStream.removeEventListener('removetrack', handleTracksChanged);
      videoEl.removeEventListener('loadedmetadata', handleReady);
      videoEl.removeEventListener('canplay', handleReady);
      for (const track of boundTracks) {
        track.removeEventListener('unmute', handleReady);
      }
      videoEl.srcObject = null;
    };
  }, [mediaStream, videoRef]);

  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;

    const wantMuted = isLocal || volume === 0;
    videoEl.volume = Math.max(0, Math.min(1, volume / 100));

    if (wantMuted) {
      autoplayMutedRef.current = false;
      videoEl.muted = true;
      return;
    }

    if (autoplayMutedRef.current) return;
    videoEl.muted = false;
  }, [isLocal, videoRef, volume]);
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

  useAttachedVideoStream(videoRef, mediaStream, stream.isLocal, stream.volume);

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
