import React from 'react';
import styles from './MultiStreamHub.module.css';
import {
  ConnectionFailureDto,
  RoomPeerDto,
  StreamFpsOption,
  StreamItem,
  SystemMetricsDto,
  WatchLayoutMode,
} from '../../domain/dtos';
import { ConnectionFailureBanner } from '../ConnectionFailureBanner/ConnectionFailureBanner';
import { StreamTile } from './StreamTile';
import { BottomDock } from './BottomDock';
import { FullscreenStreamViewer } from './FullscreenStreamViewer';

interface MultiStreamHubProps {
  hubId: string;
  peers: RoomPeerDto[];
  streams: StreamItem[];
  isSharing: boolean;
  fps: StreamFpsOption;
  isDeafened: boolean;
  layoutMode: WatchLayoutMode;
  spotlightStreamId: string | null;
  fullscreenStreamId: string | null;
  systemMetrics: SystemMetricsDto;
  highLoadSuggestion: string | null;
  connectionFailure?: ConnectionFailureDto | null;
  onToggleShare: () => void | Promise<void>;
  onSetFps: (fps: StreamFpsOption) => void | Promise<void>;
  onToggleFps: () => void | Promise<void>;
  onSetStreamVolume: (streamId: string, volume: number) => void;
  onToggleDeafen: () => void;
  onToggleLayout: () => void;
  onSelectSpotlightStream: (streamId: string) => void;
  onEnterFullscreen: (streamId?: string) => void | Promise<void>;
  onExitFullscreen: () => void | Promise<void>;
  onMinimizeHub: () => void | Promise<void>;
  onLeaveHub: () => void | Promise<void>;
  onRetryConnection?: () => void;
  onDismissConnectionFailure?: () => void;
  onDismissHighLoadSuggestion: () => void;
}

export const MultiStreamHub: React.FC<MultiStreamHubProps> = ({
  hubId,
  peers,
  streams,
  isSharing,
  fps,
  isDeafened,
  layoutMode,
  spotlightStreamId,
  fullscreenStreamId,
  systemMetrics,
  highLoadSuggestion,
  connectionFailure = null,
  onToggleShare,
  onSetFps,
  onToggleFps,
  onSetStreamVolume,
  onToggleDeafen,
  onToggleLayout,
  onSelectSpotlightStream,
  onEnterFullscreen,
  onExitFullscreen,
  onMinimizeHub,
  onLeaveHub,
  onRetryConnection,
  onDismissConnectionFailure,
  onDismissHighLoadSuggestion,
}) => {
  const fullscreenStream =
    streams.find((item) => item.id === fullscreenStreamId) ?? streams[0] ?? null;

  if (layoutMode === 'fullscreen' && fullscreenStream) {
    return (
      <div className={styles.hubShell} data-testid="multi-stream-hub">
        <FullscreenStreamViewer
          stream={fullscreenStream}
          mediaStream={fullscreenStream.mediaStream}
          onExitFullscreen={onExitFullscreen}
          onVolumeChange={(vol) => onSetStreamVolume(fullscreenStream.id, vol)}
        />
      </div>
    );
  }

  const spotlightStream =
    streams.find((item) => item.id === spotlightStreamId) ?? streams[0] ?? null;
  const sideStreams = spotlightStream
    ? streams.filter((item) => item.id !== spotlightStream.id)
    : [];
  const isSpotlightView = layoutMode === 'spotlight' && Boolean(spotlightStream);

  const renderEmptyGridPrompt = () => (
    <div className={styles.readyPromptCard}>
      <div className={styles.readyIconCircle}>
        <span className="material-symbols-outlined" style={{ fontSize: '36px', color: 'var(--primary)' }}>
          screen_share
        </span>
      </div>
      <h2 className={styles.readyTitle}>Ready to Watch &amp; Share</h2>
      <p className={styles.readySubtitle}>
        Connected to <span className={styles.readyHubTag}>{hubId}</span> · {peers.length}{' '}
        {peers.length === 1 ? 'peer' : 'peers'} in room. Anyone admitted can share their screen.
      </p>
      <button
        className={styles.readyShareBtn}
        onClick={() => void onToggleShare()}
        type="button"
      >
        <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
          screen_share
        </span>
        <span>Start Sharing Screen</span>
      </button>
    </div>
  );

  return (
    <div className={styles.hubShell} data-testid="multi-stream-hub">
      <main className={styles.mainCanvas}>
        <ConnectionFailureBanner
          failure={connectionFailure}
          onRetry={onRetryConnection}
          onDismiss={onDismissConnectionFailure}
        />
        {highLoadSuggestion && (
          <div className={styles.loadAlertBar} role="status">
            <div className={styles.loadAlertText}>
              <span className="material-symbols-outlined" style={{ fontSize: '16px', color: 'var(--tertiary)' }}>
                warning
              </span>
              <span>{highLoadSuggestion}</span>
            </div>
            <div className={styles.loadAlertActions}>
              {fps === 60 && (
                <button
                  className={styles.loadSwitchBtn}
                  onClick={() => void onSetFps(30)}
                  type="button"
                >
                  Switch to 30 FPS
                </button>
              )}
              <button
                aria-label="Dismiss load warning"
                className={styles.loadDismissBtn}
                onClick={onDismissHighLoadSuggestion}
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                  close
                </span>
              </button>
            </div>
          </div>
        )}

        {isSpotlightView && spotlightStream ? (
          <div className={styles.spotlightLayout} data-testid="streams-spotlight">
            <div className={styles.spotlightMain}>
              <StreamTile
                stream={spotlightStream}
                isSpotlight={true}
                onToggleSpotlight={onToggleLayout}
                onVolumeChange={(vol) => onSetStreamVolume(spotlightStream.id, vol)}
                onToggleFullscreen={() => onEnterFullscreen(spotlightStream.id)}
                mediaStream={spotlightStream.mediaStream}
              />
            </div>

            {sideStreams.length > 0 && (
              <div className={styles.spotlightSidebar}>
                {sideStreams.map((stream) => (
                  <StreamTile
                    key={stream.id}
                    stream={stream}
                    isSpotlight={false}
                    onToggleSpotlight={() => onSelectSpotlightStream(stream.id)}
                    onVolumeChange={(vol) => onSetStreamVolume(stream.id, vol)}
                    onToggleFullscreen={() => onEnterFullscreen(stream.id)}
                    mediaStream={stream.mediaStream}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <div
            className={`${styles.streamsGrid} ${streams.length === 0 ? styles.streamsGridEmpty : ''}`}
            data-testid="streams-grid"
          >
            {streams.length === 0
              ? renderEmptyGridPrompt()
              : streams.map((stream) => (
                  <StreamTile
                    key={stream.id}
                    stream={stream}
                    isSpotlight={false}
                    onToggleSpotlight={() => onSelectSpotlightStream(stream.id)}
                    onVolumeChange={(vol) => onSetStreamVolume(stream.id, vol)}
                    onToggleFullscreen={() => onEnterFullscreen(stream.id)}
                    mediaStream={stream.mediaStream}
                  />
                ))}
          </div>
        )}
      </main>

      <BottomDock
        isDeafened={isDeafened}
        onToggleDeafen={onToggleDeafen}
        isSharing={isSharing}
        onToggleShare={onToggleShare}
        fps={fps}
        onToggleFps={onToggleFps}
        layoutMode={layoutMode}
        onToggleLayout={onToggleLayout}
        onMinimizeHub={onMinimizeHub}
        systemMetrics={systemMetrics}
        onLeaveHub={onLeaveHub}
      />
    </div>
  );
};

export default MultiStreamHub;
