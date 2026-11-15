import React from 'react';
import styles from './MultiStreamHub.module.css';
import {
  ConnectionFailureDto,
  PeerTelemetryHistoryPointDto,
  RoomPeerDto,
  RoomRole,
  StreamFpsOption,
  StreamItem,
  StreamResolutionPreset,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
  WatchLayoutMode,
} from '../../domain/dtos';
import { formatResolutionLabel } from '../../hooks/room/roomHelpers';
import { ConnectionFailureBanner } from '../ConnectionFailureBanner/ConnectionFailureBanner';
import { StreamTile } from './StreamTile';
import { BottomDock } from './BottomDock';
import { FullscreenStreamViewer } from './FullscreenStreamViewer';
import { HubSidePanel, HubSidePanelTab } from './HubSidePanel';

interface MultiStreamHubProps {
  hubId: string;
  localPeerIdSafe: string;
  localRole: RoomRole;
  peers: RoomPeerDto[];
  streams: StreamItem[];
  streamVolumes: Record<string, number>;
  isSharing: boolean;
  isLocalPreviewEnabled: boolean;
  fps: StreamFpsOption;
  resolution: StreamResolutionPreset;
  isDeafened: boolean;
  isConnected: boolean;
  layoutMode: WatchLayoutMode;
  spotlightStreamId: string | null;
  fullscreenStreamId: string | null;
  activePanelTab: HubSidePanelTab | null;
  systemMetrics: SystemMetricsDto;
  telemetryHistory: TelemetryHistoryPointDto[];
  peerTelemetryHistory: Record<string, PeerTelemetryHistoryPointDto[]>;
  highLoadSuggestion: string | null;
  connectionFailure?: ConnectionFailureDto | null;
  onChangePanelTab: (tab: HubSidePanelTab) => void;
  onClosePanel: () => void;
  onToggleShare: () => void | Promise<void>;
  onToggleLocalPreview: () => void;
  onSetFps: (fps: StreamFpsOption) => void | Promise<void>;
  onToggleFps: () => void | Promise<void>;
  onSetResolution: (resolution: StreamResolutionPreset) => void | Promise<void>;
  onCycleResolution: () => void | Promise<void>;
  onSetStreamVolume: (streamId: string, volume: number) => void;
  onToggleDeafen: () => void;
  onToggleLayout: () => void;
  onSelectLayoutMode: (mode: WatchLayoutMode) => void;
  onSelectSpotlightStream: (streamId: string) => void;
  onEnterFullscreen: (streamId?: string) => void | Promise<void>;
  onExitFullscreen: () => void | Promise<void>;
  onMinimizeHub: () => void | Promise<void>;
  onLeaveHub: () => void | Promise<void>;
  onKickPeer: (peerIdSafe: string, reason?: string) => void | Promise<void>;
  onRetryConnection?: () => void;
  onDismissConnectionFailure?: () => void;
  onDismissHighLoadSuggestion: () => void;
}

const formatEncoderSummary = (metrics: SystemMetricsDto): string => {
  const codec = metrics.activeCodec || 'Auto';
  if (metrics.isHardwareAccelerated === true) {
    return `HW Accelerated · ${codec}`;
  }
  if (metrics.isHardwareAccelerated === false) {
    return `CPU Fallback · ${codec}`;
  }
  return 'Auto Hardware Selection';
};

const getGridDensityClass = (count: number): string => {
  if (count <= 1) return styles.gridOne;
  if (count === 2) return styles.gridTwo;
  if (count <= 4) return styles.gridFour;
  return styles.gridMany;
};

export const MultiStreamHub: React.FC<MultiStreamHubProps> = ({
  hubId,
  localPeerIdSafe,
  localRole,
  peers,
  streams,
  streamVolumes,
  isSharing,
  isLocalPreviewEnabled,
  fps,
  resolution,
  isDeafened,
  isConnected,
  layoutMode,
  spotlightStreamId,
  fullscreenStreamId,
  activePanelTab,
  systemMetrics,
  telemetryHistory,
  peerTelemetryHistory,
  highLoadSuggestion,
  connectionFailure = null,
  onChangePanelTab,
  onClosePanel,
  onToggleShare,
  onToggleLocalPreview,
  onSetFps,
  onToggleFps,
  onSetResolution,
  onCycleResolution,
  onSetStreamVolume,
  onToggleDeafen,
  onToggleLayout,
  onSelectLayoutMode,
  onSelectSpotlightStream,
  onEnterFullscreen,
  onExitFullscreen,
  onMinimizeHub,
  onLeaveHub,
  onKickPeer,
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
  const isFocusView = layoutMode === 'focus' && Boolean(spotlightStream);
  const remoteViewerCount = Math.max(0, peers.length - 1);

  const isPeerHost = (peerIdSafe: string): boolean => {
    const matched = peers.find((peer) => peer.peerIdSafe === peerIdSafe);
    return matched?.role === 'owner';
  };

  const getPeerLatency = (stream: StreamItem): number => {
    if (stream.isLocal) return 0;
    const peerStat = systemMetrics.peerStats?.[stream.peerIdSafe];
    if (peerStat) return peerStat.rttMs;
    return systemMetrics.rttMs > 0 ? systemMetrics.rttMs : 0;
  };

  const renderEmptyGridPrompt = () => {
    if (isSharing) {
      const bitrateMbps =
        systemMetrics.outboundBitrateKbps > 0
          ? ` · ${(systemMetrics.outboundBitrateKbps / 1000).toFixed(1)} Mbps`
          : '';
      return (
        <div className={styles.readyPromptCard} data-testid="local-stream-hidden-card">
          <div className={`${styles.readyIconCircle} ${styles.liveIconCircle}`}>
            <span className="material-symbols-outlined" style={{ fontSize: '34px', color: '#10b981' }}>
              cast_connected
            </span>
          </div>
          <h2 className={styles.readyTitle}>You Are Live</h2>
          <p className={styles.readySubtitle}>
            Streaming <span className={styles.readyHubTag}>{formatResolutionLabel(resolution)} · {fps} FPS</span>
            {bitrateMbps} to {remoteViewerCount} {remoteViewerCount === 1 ? 'viewer' : 'viewers'}.
            Self-preview is off by default to preserve gaming FPS &amp; RAM.
          </p>
          <div className={styles.encoderStatusPill} data-testid="encoder-status-pill">
            {formatEncoderSummary(systemMetrics)}
          </div>
          <div className={styles.liveCardActions}>
            <button
              className={styles.previewToggleBtn}
              data-testid="toggle-self-preview-btn"
              onClick={onToggleLocalPreview}
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                visibility
              </span>
              <span>Preview My Stream</span>
            </button>
            <button
              className={styles.stopShareCardBtn}
              onClick={() => void onToggleShare()}
              type="button"
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                stop_screen_share
              </span>
              <span>Stop Sharing</span>
            </button>
          </div>
        </div>
      );
    }

    return (
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
  };

  const renderStage = () => {
    if (streams.length === 0) {
      return (
        <div
          className={`${styles.streamsGrid} ${styles.streamsGridEmpty}`}
          data-testid="streams-grid"
        >
          {renderEmptyGridPrompt()}
        </div>
      );
    }

    if (isSpotlightView && spotlightStream) {
      return (
        <div className={styles.spotlightLayout} data-testid="streams-spotlight">
          <div className={styles.spotlightMain}>
            <StreamTile
              stream={spotlightStream}
              isSpotlight={true}
              isHost={isPeerHost(spotlightStream.peerIdSafe)}
              peerLatencyMs={getPeerLatency(spotlightStream)}
              onToggleSpotlight={onToggleLayout}
              onVolumeChange={(vol) => onSetStreamVolume(spotlightStream.id, vol)}
              onToggleFullscreen={() => onEnterFullscreen(spotlightStream.id)}
              mediaStream={spotlightStream.mediaStream}
            />
          </div>

          {sideStreams.length > 0 && (
            <div className={styles.spotlightStrip}>
              {sideStreams.map((stream) => (
                <div
                  key={stream.id}
                  className={styles.spotlightThumbItem}
                  onClick={(e) => {
                    if ((e.target as HTMLElement | null)?.closest('button, input')) return;
                    onSelectSpotlightStream(stream.id);
                  }}
                >
                  <StreamTile
                    stream={stream}
                    isSpotlight={false}
                    compact={true}
                    isHost={isPeerHost(stream.peerIdSafe)}
                    peerLatencyMs={getPeerLatency(stream)}
                    onToggleSpotlight={() => onSelectSpotlightStream(stream.id)}
                    onVolumeChange={(vol) => onSetStreamVolume(stream.id, vol)}
                    onToggleFullscreen={() => onEnterFullscreen(stream.id)}
                    mediaStream={stream.mediaStream}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (isFocusView && spotlightStream) {
      return (
        <div className={styles.focusLayout} data-testid="streams-focus">
          <div className={styles.focusStage}>
            <StreamTile
              stream={spotlightStream}
              isSpotlight={false}
              isFocused={true}
              isHost={isPeerHost(spotlightStream.peerIdSafe)}
              peerLatencyMs={getPeerLatency(spotlightStream)}
              onToggleSpotlight={() => onSelectLayoutMode('grid')}
              onVolumeChange={(vol) => onSetStreamVolume(spotlightStream.id, vol)}
              onToggleFullscreen={() => onEnterFullscreen(spotlightStream.id)}
              mediaStream={spotlightStream.mediaStream}
            />
          </div>

          {streams.length > 1 && (
            <div className={styles.focusSwitcherBar}>
              {streams.map((stream) => (
                <button
                  key={stream.id}
                  className={`${styles.focusChip} ${
                    stream.id === spotlightStream.id ? styles.focusChipActive : ''
                  }`}
                  onClick={() => {
                    onSelectSpotlightStream(stream.id);
                    onSelectLayoutMode('focus');
                  }}
                  type="button"
                >
                  <span className={styles.focusChipDot} />
                  <span>{stream.name}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    return (
      <div
        className={`${styles.streamsGrid} ${getGridDensityClass(streams.length)}`}
        data-testid="streams-grid"
      >
        {streams.map((stream) => (
          <StreamTile
            key={stream.id}
            stream={stream}
            isSpotlight={false}
            isHost={isPeerHost(stream.peerIdSafe)}
            peerLatencyMs={getPeerLatency(stream)}
            onToggleSpotlight={() => onSelectSpotlightStream(stream.id)}
            onVolumeChange={(vol) => onSetStreamVolume(stream.id, vol)}
            onToggleFullscreen={() => onEnterFullscreen(stream.id)}
            mediaStream={stream.mediaStream}
          />
        ))}
      </div>
    );
  };

  return (
    <div className={styles.hubShell} data-testid="multi-stream-hub">
      <div className={styles.hubBody}>
        <div className={styles.stageColumn}>
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
                  {fps === 120 && (
                    <button
                      className={styles.loadSwitchBtn}
                      onClick={() => void onSetFps(60)}
                      type="button"
                    >
                      Switch to 60 FPS
                    </button>
                  )}
                  {fps === 60 && (
                    <button
                      className={styles.loadSwitchBtn}
                      onClick={() => void onSetFps(30)}
                      type="button"
                    >
                      Switch to 30 FPS
                    </button>
                  )}
                  {resolution !== '720p' && (
                    <button
                      className={styles.loadSwitchBtn}
                      onClick={() => void onSetResolution('720p')}
                      type="button"
                    >
                      Switch to 720p
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

            {renderStage()}
          </main>

          <BottomDock
            isDeafened={isDeafened}
            onToggleDeafen={onToggleDeafen}
            isSharing={isSharing}
            isLocalPreviewEnabled={isLocalPreviewEnabled}
            onToggleShare={onToggleShare}
            onToggleLocalPreview={onToggleLocalPreview}
            fps={fps}
            onToggleFps={onToggleFps}
            resolution={resolution}
            onCycleResolution={onCycleResolution}
            layoutMode={layoutMode}
            onToggleLayout={onToggleLayout}
            onMinimizeHub={onMinimizeHub}
            systemMetrics={systemMetrics}
            onLeaveHub={onLeaveHub}
          />
        </div>

        <HubSidePanel
          isOpen={activePanelTab !== null}
          activeTab={activePanelTab ?? 'participants'}
          onChangeTab={onChangePanelTab}
          onClose={onClosePanel}
          hubId={hubId}
          localPeerIdSafe={localPeerIdSafe}
          localRole={localRole}
          peers={peers}
          streams={streams}
          streamVolumes={streamVolumes}
          isDeafened={isDeafened}
          fps={fps}
          resolution={resolution}
          isConnected={isConnected}
          systemMetrics={systemMetrics}
          telemetryHistory={telemetryHistory}
          peerTelemetryHistory={peerTelemetryHistory}
          onSetStreamVolume={onSetStreamVolume}
          onKickPeer={onKickPeer}
        />
      </div>
    </div>
  );
};

export default MultiStreamHub;
