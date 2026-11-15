import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import { localWindowBus, telemetryAdapter, webrtcStreamEngine } from '../adapters';
import { STREAM_CONFIG } from '../domain/config';
import {
  ConnectionFailureDto,
  DataChannelPayload,
  RoomPeerDto,
  StreamFpsOption,
  StreamItem,
  StreamResolutionPreset,
  StreamStartedPayload,
  WatchLayoutMode,
} from '../domain/dtos';
import { isStreamResolutionPreset } from '../domain/validators';
import { formatFullPeerTag } from '../utils/hubTopics';
import { minimizeWindowTauri, restoreStreamWindowTauri, setFullscreenTauri } from '../utils/tauri';
import {
  RemoteStreamMeta,
  RoomIdentityRefs,
  formatResolutionLabel,
  getNextFpsOption,
  getNextResolutionPreset,
  toPeerCountTier,
} from './room/roomHelpers';

const STREAM_RESOLUTION_STORAGE_KEY = 'elfy_stream_resolution';

type NonFullscreenLayoutMode = Exclude<WatchLayoutMode, 'fullscreen'>;

export interface StopSharingOptions {
  skipRenegotiate?: boolean;
}

const areStreamListsEqual = (prev: StreamItem[], next: StreamItem[]): boolean => {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i += 1) {
    const a = prev[i];
    const b = next[i];
    if (
      a.id !== b.id ||
      a.peerIdSafe !== b.peerIdSafe ||
      a.name !== b.name ||
      a.tag !== b.tag ||
      a.resolution !== b.resolution ||
      a.fps !== b.fps ||
      a.avatarUrl !== b.avatarUrl ||
      a.isLive !== b.isLive ||
      a.volume !== b.volume ||
      a.isLocal !== b.isLocal ||
      a.mediaStream !== b.mediaStream
    ) {
      return false;
    }
  }
  return true;
};

const readInitialResolution = (): StreamResolutionPreset => {
  if (typeof localStorage === 'undefined') return STREAM_CONFIG.DEFAULT_RESOLUTION;
  try {
    const saved = localStorage.getItem(STREAM_RESOLUTION_STORAGE_KEY);
    return isStreamResolutionPreset(saved) ? saved : STREAM_CONFIG.DEFAULT_RESOLUTION;
  } catch {
    return STREAM_CONFIG.DEFAULT_RESOLUTION;
  }
};

export interface UseMediaSharingOptions extends RoomIdentityRefs {
  normalizedHub: string;
  initialFps: StreamFpsOption;
  getPeersSnapshot: () => RoomPeerDto[];
  getHostPeerId: () => string;
  onPeerStreamingChanged: (peerIdSafe: string, streaming: boolean) => void;
  onBroadcastDataChannel: (payload: DataChannelPayload) => void;
  onCaptureError: (failure: ConnectionFailureDto | null) => void;
}

export interface UseMediaSharingResult {
  streams: StreamItem[];
  localStream: MediaStream | null;
  isSharing: boolean;
  isLocalPreviewEnabled: boolean;
  fps: StreamFpsOption;
  resolution: StreamResolutionPreset;
  isDeafened: boolean;
  layoutMode: WatchLayoutMode;
  spotlightStreamId: string | null;
  fullscreenStreamId: string | null;
  isMinimized: boolean;
  streamVolumes: Record<string, number>;
  streamsRef: MutableRefObject<StreamItem[]>;
  localStreamRef: MutableRefObject<MediaStream | null>;
  isSharingRef: MutableRefObject<boolean>;
  fpsRef: MutableRefObject<StreamFpsOption>;
  resolutionRef: MutableRefObject<StreamResolutionPreset>;
  remoteStreamsRef: MutableRefObject<Map<string, MediaStream>>;
  remoteMetaRef: MutableRefObject<Map<string, RemoteStreamMeta>>;
  rebuildStreams: () => void;
  startSharing: () => Promise<void>;
  stopSharing: (options?: StopSharingOptions) => Promise<void>;
  toggleSharing: () => Promise<void>;
  toggleLocalPreview: () => void;
  setLocalPreviewEnabled: (enabled: boolean) => void;
  setFps: (fps: StreamFpsOption) => Promise<void>;
  toggleFps: () => Promise<void>;
  setResolution: (resolution: StreamResolutionPreset) => Promise<void>;
  cycleResolution: () => Promise<void>;
  setStreamVolume: (streamId: string, volume: number) => void;
  toggleDeafen: () => void;
  setLayoutMode: (mode: WatchLayoutMode) => void;
  toggleLayoutMode: () => void;
  selectSpotlightStream: (streamId: string) => void;
  enterFullscreen: (streamId?: string) => Promise<void>;
  exitFullscreen: () => Promise<void>;
  minimizeHub: () => Promise<void>;
  restoreHub: () => Promise<void>;
  resetMediaState: () => void;
}

/**
 * Manages screen capture, FPS adaptation, remote stream lists, volume/deafen,
 * watch layout modes, fullscreen, and hub minimize/restore window state.
 */
export const useMediaSharing = ({
  normalizedHub,
  initialFps,
  mountedRef,
  profileRef,
  roleRef,
  hubRef,
  localPeerIdRef,
  hostInfoRef,
  getPeersSnapshot,
  getHostPeerId,
  onPeerStreamingChanged,
  onBroadcastDataChannel,
  onCaptureError,
}: UseMediaSharingOptions): UseMediaSharingResult => {
  const [streams, setStreams] = useState<StreamItem[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isSharing, setIsSharing] = useState<boolean>(false);
  const [isLocalPreviewEnabled, setIsLocalPreviewEnabledState] = useState<boolean>(false);
  const [fps, setFpsState] = useState<StreamFpsOption>(initialFps);
  const [resolution, setResolutionState] = useState<StreamResolutionPreset>(readInitialResolution);
  const [isDeafened, setIsDeafened] = useState<boolean>(false);
  const [layoutMode, setLayoutModeState] = useState<WatchLayoutMode>('grid');
  const [spotlightStreamId, setSpotlightStreamId] = useState<string | null>(null);
  const [fullscreenStreamId, setFullscreenStreamId] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [streamVolumes, setStreamVolumes] = useState<Record<string, number>>({});

  const streamsRef = useRef<StreamItem[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const isSharingRef = useRef<boolean>(false);
  const isLocalPreviewEnabledRef = useRef<boolean>(false);
  const fpsRef = useRef<StreamFpsOption>(fps);
  const resolutionRef = useRef<StreamResolutionPreset>(resolution);
  const isDeafenedRef = useRef<boolean>(false);
  const isMinimizedRef = useRef<boolean>(false);
  const preFullscreenLayoutRef = useRef<NonFullscreenLayoutMode>('grid');
  const isChangingFpsRef = useRef<boolean>(false);

  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const remoteMetaRef = useRef<Map<string, RemoteStreamMeta>>(new Map());
  const streamVolumesRef = useRef<Map<string, number>>(new Map());

  useEffect(() => {
    setIsMinimized(false);
    isMinimizedRef.current = false;
  }, [normalizedHub]);

  const buildRemoteStreamItem = useCallback(
    (peerIdSafe: string, mediaStream: MediaStream): StreamItem => {
      const peer = getPeersSnapshot().find((item) => item.peerIdSafe === peerIdSafe);
      const meta = remoteMetaRef.current.get(peerIdSafe);
      const savedVol = streamVolumesRef.current.get(peerIdSafe) ?? 100;
      const fallbackTag =
        peerIdSafe === getHostPeerId()
          ? formatFullPeerTag(hostInfoRef.current.displayName, hostInfoRef.current.tag)
          : peerIdSafe;

      return {
        id: peerIdSafe,
        peerIdSafe,
        name: peer?.displayName || meta?.displayName || hostInfoRef.current.displayName || 'Peer',
        tag: peer?.peerTag || fallbackTag,
        resolution: meta?.resolution || STREAM_CONFIG.DEFAULT_RESOLUTION,
        fps: meta?.fps ?? STREAM_CONFIG.DEFAULT_FPS,
        avatarUrl: peer?.avatarUrl || meta?.avatarUrl || '',
        isLive: true,
        volume: isDeafenedRef.current ? 0 : savedVol,
        isLocal: false,
        mediaStream,
      };
    },
    [getHostPeerId, getPeersSnapshot, hostInfoRef]
  );

  const syncMinimizedBanner = useCallback(
    (activeStreamsCount: number): void => {
      if (!isMinimizedRef.current || !hubRef.current) return;
      void localWindowBus.publish({
        type: 'minimized_hub_updated',
        hub: {
          hubId: hubRef.current,
          role: roleRef.current,
          activeStreamsCount,
          isSharing: isSharingRef.current,
          minimizedAt: Date.now(),
        },
      });
    },
    [hubRef, roleRef]
  );

  const rebuildStreams = useCallback((): void => {
    const next: StreamItem[] = [];
    const currentLocal = localStreamRef.current;

    if (currentLocal && isSharingRef.current && isLocalPreviewEnabledRef.current) {
      const selfId = localPeerIdRef.current;
      next.push({
        id: selfId,
        peerIdSafe: selfId,
        name: profileRef.current.nickname,
        tag: formatFullPeerTag(profileRef.current.nickname, profileRef.current.peerTag),
        resolution: formatResolutionLabel(resolutionRef.current),
        fps: fpsRef.current,
        avatarUrl: profileRef.current.avatarUrl,
        isLive: true,
        volume: streamVolumesRef.current.get(selfId) ?? 100,
        isLocal: true,
        mediaStream: currentLocal,
      });
    }

    for (const [peerIdSafe, mediaStream] of remoteStreamsRef.current.entries()) {
      next.push(buildRemoteStreamItem(peerIdSafe, mediaStream));
    }

    streamsRef.current = next;
    syncMinimizedBanner(next.length);
    if (!mountedRef.current) return;

    const activeIds = new Set(next.map((item) => item.id));
    setStreams((prev) => (areStreamListsEqual(prev, next) ? prev : next));
    setSpotlightStreamId((prev) => (prev && activeIds.has(prev) ? prev : null));
    setFullscreenStreamId((prev) => (prev && activeIds.has(prev) ? prev : null));
  }, [buildRemoteStreamItem, localPeerIdRef, mountedRef, profileRef, syncMinimizedBanner]);

  const broadcastActiveStreamMetadata = useCallback((): void => {
    if (!isSharingRef.current) return;
    const payload: StreamStartedPayload = {
      type: 'stream_started',
      peerIdSafe: localPeerIdRef.current,
      displayName: profileRef.current.nickname,
      avatarUrl: profileRef.current.avatarUrl,
      resolution: formatResolutionLabel(resolutionRef.current),
      fps: fpsRef.current,
    };
    onBroadcastDataChannel(payload);
  }, [localPeerIdRef, onBroadcastDataChannel, profileRef]);

  const setLocalPreviewEnabled = useCallback(
    (enabled: boolean): void => {
      isLocalPreviewEnabledRef.current = enabled;
      if (mountedRef.current) {
        setIsLocalPreviewEnabledState(enabled);
      }
      rebuildStreams();
    },
    [mountedRef, rebuildStreams]
  );

  const toggleLocalPreview = useCallback((): void => {
    setLocalPreviewEnabled(!isLocalPreviewEnabledRef.current);
  }, [setLocalPreviewEnabled]);

  const handleLocalTrackEnded = useCallback(
    (event?: Event): void => {
      if (!isSharingRef.current || isChangingFpsRef.current) return;
      const currentTrack = localStreamRef.current?.getVideoTracks()[0];
      if (event?.target && currentTrack && event.target !== currentTrack) return;

      localStreamRef.current = null;
      isSharingRef.current = false;
      isLocalPreviewEnabledRef.current = false;
      if (mountedRef.current) {
        setLocalStream(null);
        setIsSharing(false);
        setIsLocalPreviewEnabledState(false);
      }
      onPeerStreamingChanged(localPeerIdRef.current, false);
      onBroadcastDataChannel({ type: 'stream_stopped', peerIdSafe: localPeerIdRef.current });
      void webrtcStreamEngine.renegotiateAllPeers();
      rebuildStreams();
    },
    [
      localPeerIdRef,
      mountedRef,
      onBroadcastDataChannel,
      onPeerStreamingChanged,
      rebuildStreams,
    ]
  );

  const startSharing = useCallback(async (): Promise<void> => {
    if (isSharingRef.current) return;
    try {
      const targetFps = fpsRef.current;
      const targetResolution = resolutionRef.current;
      const stream = await webrtcStreamEngine.startScreenCapture(targetFps, targetResolution);
      if (!mountedRef.current) {
        await webrtcStreamEngine.stopScreenCapture();
        return;
      }

      localStreamRef.current = stream;
      isSharingRef.current = true;
      isLocalPreviewEnabledRef.current = false;
      setLocalStream(stream);
      setIsSharing(true);
      setIsLocalPreviewEnabledState(false);
      onCaptureError(null);

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', handleLocalTrackEnded, { once: true });
      }

      onPeerStreamingChanged(localPeerIdRef.current, true);
      rebuildStreams();

      broadcastActiveStreamMetadata();
      await webrtcStreamEngine.renegotiateAllPeers();

      void telemetryAdapter.trackEvent('stream_started', {
        role: roleRef.current,
        fps: targetFps,
        peerCountTier: toPeerCountTier(getPeersSnapshot().length),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      onCaptureError({
        stage: 'screen_capture',
        reason:
          err instanceof Error && err.message ? err.message : 'Unable to start screen capture.',
        timestamp: Date.now(),
      });
    }
  }, [
    broadcastActiveStreamMetadata,
    getPeersSnapshot,
    handleLocalTrackEnded,
    localPeerIdRef,
    mountedRef,
    onCaptureError,
    onPeerStreamingChanged,
    rebuildStreams,
    roleRef,
  ]);

  const stopSharing = useCallback(async (options?: StopSharingOptions): Promise<void> => {
    if (!isSharingRef.current && !localStreamRef.current) return;
    const oldTrack = localStreamRef.current?.getVideoTracks()[0];
    if (oldTrack) {
      oldTrack.removeEventListener('ended', handleLocalTrackEnded);
    }

    localStreamRef.current = null;
    isSharingRef.current = false;
    isLocalPreviewEnabledRef.current = false;
    if (mountedRef.current) {
      setLocalStream(null);
      setIsSharing(false);
      setIsLocalPreviewEnabledState(false);
    }

    await webrtcStreamEngine.stopScreenCapture();
    onPeerStreamingChanged(localPeerIdRef.current, false);
    rebuildStreams();

    if (!options?.skipRenegotiate) {
      onBroadcastDataChannel({ type: 'stream_stopped', peerIdSafe: localPeerIdRef.current });
      await webrtcStreamEngine.renegotiateAllPeers();
    }

    void telemetryAdapter.trackEvent('stream_stopped', {
      role: roleRef.current,
      fps: fpsRef.current,
      peerCountTier: toPeerCountTier(getPeersSnapshot().length),
    });
  }, [
    getPeersSnapshot,
    handleLocalTrackEnded,
    localPeerIdRef,
    mountedRef,
    onBroadcastDataChannel,
    onPeerStreamingChanged,
    rebuildStreams,
    roleRef,
  ]);

  const toggleSharing = useCallback(async (): Promise<void> => {
    if (isSharingRef.current) {
      await stopSharing();
      return;
    }
    await startSharing();
  }, [startSharing, stopSharing]);

  const setFps = useCallback(
    async (nextFps: StreamFpsOption): Promise<void> => {
      fpsRef.current = nextFps;
      if (mountedRef.current) setFpsState(nextFps);

      const previousTrack = localStreamRef.current?.getVideoTracks()[0];
      isChangingFpsRef.current = true;
      try {
        await webrtcStreamEngine.setStreamFps(nextFps);
      } finally {
        isChangingFpsRef.current = false;
      }

      const refreshedLocal = webrtcStreamEngine.getLocalStream();
      if (refreshedLocal) {
        localStreamRef.current = refreshedLocal;
        const nextTrack = refreshedLocal.getVideoTracks()[0];
        if (nextTrack && nextTrack !== previousTrack) {
          previousTrack?.removeEventListener('ended', handleLocalTrackEnded);
          nextTrack.addEventListener('ended', handleLocalTrackEnded, { once: true });
        }
        if (mountedRef.current) setLocalStream(refreshedLocal);
      }

      broadcastActiveStreamMetadata();
      rebuildStreams();
      void telemetryAdapter.trackEvent('fps_changed', { role: roleRef.current, fps: nextFps });
    },
    [
      broadcastActiveStreamMetadata,
      handleLocalTrackEnded,
      mountedRef,
      rebuildStreams,
      roleRef,
    ]
  );

  const toggleFps = useCallback(async (): Promise<void> => {
    await setFps(getNextFpsOption(fpsRef.current));
  }, [setFps]);

  const setResolution = useCallback(
    async (nextResolution: StreamResolutionPreset): Promise<void> => {
      resolutionRef.current = nextResolution;
      if (mountedRef.current) setResolutionState(nextResolution);
      try {
        localStorage.setItem(STREAM_RESOLUTION_STORAGE_KEY, nextResolution);
      } catch {
        // Ignore storage quota errors cleanly.
      }

      await webrtcStreamEngine.setStreamResolution(nextResolution);
      broadcastActiveStreamMetadata();
      rebuildStreams();
    },
    [broadcastActiveStreamMetadata, mountedRef, rebuildStreams]
  );

  const cycleResolution = useCallback(async (): Promise<void> => {
    await setResolution(getNextResolutionPreset(resolutionRef.current));
  }, [setResolution]);

  const setStreamVolume = useCallback(
    (streamId: string, volume: number): void => {
      if (!streamId) return;
      const clamped = Math.max(0, Math.min(100, Math.round(volume)));
      streamVolumesRef.current.set(streamId, clamped);
      if (mountedRef.current) {
        setStreamVolumes((prev) =>
          prev[streamId] === clamped ? prev : { ...prev, [streamId]: clamped }
        );
      }
      rebuildStreams();
    },
    [mountedRef, rebuildStreams]
  );

  const toggleDeafen = useCallback((): void => {
    const next = !isDeafenedRef.current;
    isDeafenedRef.current = next;
    setIsDeafened(next);
    rebuildStreams();
  }, [rebuildStreams]);

  const setLayoutMode = useCallback((mode: WatchLayoutMode): void => {
    if (mode !== 'fullscreen') {
      preFullscreenLayoutRef.current = mode;
      setFullscreenStreamId(null);
    }
    setLayoutModeState(mode);
  }, []);

  const toggleLayoutMode = useCallback((): void => {
    setLayoutModeState((prev) => {
      const next = prev === 'grid' ? 'spotlight' : 'grid';
      preFullscreenLayoutRef.current = next;
      setFullscreenStreamId(null);
      return next;
    });
  }, []);

  const selectSpotlightStream = useCallback((streamId: string): void => {
    setSpotlightStreamId(streamId);
    preFullscreenLayoutRef.current = 'spotlight';
    setFullscreenStreamId(null);
    setLayoutModeState('spotlight');
  }, []);

  const enterFullscreen = useCallback(
    async (streamId?: string): Promise<void> => {
      const targetId = streamId || spotlightStreamId || streamsRef.current[0]?.id || null;
      if (!targetId) return;
      if (layoutMode !== 'fullscreen') {
        preFullscreenLayoutRef.current = layoutMode;
      }
      setFullscreenStreamId(targetId);
      setLayoutModeState('fullscreen');
      await setFullscreenTauri(true).catch(() => {});
    },
    [layoutMode, spotlightStreamId]
  );

  const exitFullscreen = useCallback(async (): Promise<void> => {
    setFullscreenStreamId(null);
    setLayoutModeState(preFullscreenLayoutRef.current);
    await setFullscreenTauri(false).catch(() => {});
  }, []);

  const minimizeHub = useCallback(async (): Promise<void> => {
    if (!hubRef.current) return;
    isMinimizedRef.current = true;
    setIsMinimized(true);

    await localWindowBus.publish({
      type: 'minimized_hub_updated',
      hub: {
        hubId: hubRef.current,
        role: roleRef.current,
        activeStreamsCount: streamsRef.current.length,
        isSharing: isSharingRef.current,
        minimizedAt: Date.now(),
      },
    });

    await minimizeWindowTauri();
  }, [hubRef, roleRef]);

  const restoreHub = useCallback(async (): Promise<void> => {
    isMinimizedRef.current = false;
    setIsMinimized(false);
    if (hubRef.current) {
      await localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
    }
    await restoreStreamWindowTauri();
  }, [hubRef]);

  const resetMediaState = useCallback((): void => {
    const oldTrack = localStreamRef.current?.getVideoTracks()[0];
    if (oldTrack) {
      oldTrack.removeEventListener('ended', handleLocalTrackEnded);
    }
    void webrtcStreamEngine.stopScreenCapture();
    localStreamRef.current = null;
    isSharingRef.current = false;
    isLocalPreviewEnabledRef.current = false;
    remoteStreamsRef.current.clear();
    remoteMetaRef.current.clear();
    streamVolumesRef.current.clear();
    streamsRef.current = [];
    isMinimizedRef.current = false;

    if (!mountedRef.current) return;
    setLocalStream(null);
    setIsSharing(false);
    setIsLocalPreviewEnabledState(false);
    setIsMinimized(false);
    setSpotlightStreamId(null);
    setFullscreenStreamId(null);
    setLayoutModeState((prev) => (prev === 'fullscreen' ? preFullscreenLayoutRef.current : prev));
    setStreamVolumes({});
    setStreams([]);
  }, [handleLocalTrackEnded, mountedRef]);

  return {
    streams,
    localStream,
    isSharing,
    isLocalPreviewEnabled,
    fps,
    resolution,
    isDeafened,
    layoutMode,
    spotlightStreamId,
    fullscreenStreamId,
    isMinimized,
    streamVolumes,
    streamsRef,
    localStreamRef,
    isSharingRef,
    fpsRef,
    resolutionRef,
    remoteStreamsRef,
    remoteMetaRef,
    rebuildStreams,
    startSharing,
    stopSharing,
    toggleSharing,
    toggleLocalPreview,
    setLocalPreviewEnabled,
    setFps,
    toggleFps,
    setResolution,
    cycleResolution,
    setStreamVolume,
    toggleDeafen,
    setLayoutMode,
    toggleLayoutMode,
    selectSpotlightStream,
    enterFullscreen,
    exitFullscreen,
    minimizeHub,
    restoreHub,
    resetMediaState,
  };
};
