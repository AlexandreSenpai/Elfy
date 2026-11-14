import { useCallback, useEffect, useRef, useState } from 'react';
import {
  localWindowBus,
  signalingTransport,
  storageRepository,
  systemMonitorAdapter,
  telemetryAdapter,
  webrtcStreamEngine,
} from '../adapters';
import { ROOM_CONFIG, STREAM_CONFIG } from '../domain/config';
import {
  ConnectionFailureDto,
  DataChannelEnvelopeDto,
  DataChannelMessageType,
  HubStatusResponsePayload,
  KnockDecisionPayload,
  KnockRequestPayload,
  KnockStatus,
  LocalWindowBusMessage,
  LocalWindowBusMessageType,
  PendingKnock,
  RoomPeerDto,
  RoomRole,
  SignalingEnvelopeDto,
  SignalingMessageType,
  SignalingPayload,
  StreamFpsOption,
  StreamItem,
  StreamStartedPayload,
  SystemMetricsDto,
  UserProfile,
  WatchLayoutMode,
} from '../domain/dtos';
import { DEFAULT_USER_PROFILE } from '../data/mockData';
import { canAcceptMorePeers } from '../domain/validators';
import { StreamEngineCallbacks } from '../ports';
import {
  extractHostFromHub,
  formatFullPeerTag,
  getGuestInboxTopic,
  getKnockTopic,
  getProbeTopic,
  isHubOwner,
  normalizeHubTopic,
  toSafePeerTag,
} from '../utils/hubTopics';
import {
  minimizeWindowTauri,
  restoreStreamWindowTauri,
  setFullscreenTauri,
} from '../utils/tauri';

export interface UseRoomSessionOptions {
  hubId: string;
  profile: UserProfile;
  role?: RoomRole;
  autoStart?: boolean;
  isProfileLoading?: boolean;
}

export interface UseRoomSessionResult {
  hubId: string;
  role: RoomRole;
  hostInfo: { displayName: string; tag: string };
  isConnected: boolean;
  hasLeftRoom: boolean;
  knockStatus: KnockStatus;
  knockError: string | null;
  entranceAccepted: boolean;
  pendingKnocks: PendingKnock[];
  peers: RoomPeerDto[];
  streams: StreamItem[];
  localStream: MediaStream | null;
  isSharing: boolean;
  fps: StreamFpsOption;
  isDeafened: boolean;
  layoutMode: WatchLayoutMode;
  spotlightStreamId: string | null;
  fullscreenStreamId: string | null;
  isMinimized: boolean;
  systemMetrics: SystemMetricsDto;
  highLoadSuggestion: string | null;
  connectionFailure: ConnectionFailureDto | null;
  requestEntrance: () => Promise<void>;
  cancelKnock: () => void;
  acceptKnock: (knock: PendingKnock) => Promise<void>;
  rejectKnock: (knock: PendingKnock) => Promise<void>;
  startSharing: () => Promise<void>;
  stopSharing: () => Promise<void>;
  toggleSharing: () => Promise<void>;
  setFps: (fps: StreamFpsOption) => Promise<void>;
  toggleFps: () => Promise<void>;
  setStreamVolume: (streamId: string, volume: number) => void;
  toggleDeafen: () => void;
  setLayoutMode: (mode: WatchLayoutMode) => void;
  toggleLayoutMode: () => void;
  selectSpotlightStream: (streamId: string) => void;
  enterFullscreen: (streamId?: string) => Promise<void>;
  exitFullscreen: () => Promise<void>;
  minimizeHub: () => Promise<void>;
  restoreHub: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  rejoinRoom: () => void;
  retryConnection: () => void;
  dismissConnectionFailure: () => void;
  dismissHighLoadSuggestion: () => void;
}

interface RemoteStreamMeta {
  resolution: string;
  fps: StreamFpsOption;
  displayName?: string;
  avatarUrl?: string;
}

const KNOCK_TIMEOUT_MS = 30000;
const METRICS_POLL_MS = 2000;

const EMPTY_METRICS: SystemMetricsDto = {
  cpuUsagePercent: 0,
  memoryUsedMb: 0,
  memoryTotalMb: 0,
  highLoadWarning: false,
  outboundFps: 0,
  inboundFps: 0,
  droppedFrames: 0,
  rttMs: 0,
};

const createUniqueId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
};

const toPeerCountTier = (count: number): string => {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  return '4+';
};

const toCpuTier = (cpu: number): string => {
  if (cpu >= 80) return 'high';
  if (cpu >= 50) return 'medium';
  return 'low';
};

const toRamTier = (usedMb: number, totalMb: number): string => {
  if (totalMb <= 0) return 'unknown';
  const ratio = usedMb / totalMb;
  if (ratio >= 0.85) return 'high';
  if (ratio >= 0.6) return 'medium';
  return 'low';
};

const toRttBucket = (rttMs: number): string => {
  if (rttMs <= 0) return 'unknown';
  if (rttMs < 25) return '0-25ms';
  if (rttMs < 60) return '25-60ms';
  return '60ms+';
};

const isWaitingForDefaultProfile = (options: UseRoomSessionOptions): boolean => {
  if (options.isProfileLoading !== undefined) {
    return options.isProfileLoading;
  }
  if (options.profile.machineHash) return false;
  return (
    options.profile.peerTag === DEFAULT_USER_PROFILE.peerTag &&
    options.profile.nickname === DEFAULT_USER_PROFILE.nickname
  );
};

const createSignalingEnvelope = <T extends SignalingPayload>(
  hubId: string,
  senderPeerIdSafe: string,
  payload: T
): SignalingEnvelopeDto<T> => ({
  version: 1,
  messageId: createUniqueId('msg'),
  hubId,
  senderPeerIdSafe,
  sentAt: Date.now(),
  payload,
});

const createSelfPeer = (
  profile: UserProfile,
  peerIdSafe: string,
  role: RoomRole,
  isStreaming: boolean
): RoomPeerDto => ({
  peerIdSafe,
  peerTag: formatFullPeerTag(profile.nickname, profile.peerTag),
  displayName: profile.nickname,
  avatarUrl: profile.avatarUrl,
  role,
  isStreaming,
  joinedAt: Date.now(),
});

const getMeshTokenForPair = (hubId: string, peerA: string, peerB: string): string => {
  const ordered = [peerA, peerB].sort().join('__');
  return `mesh_${hubId}_${ordered}`;
};

type SignalingHandler = (envelope: SignalingEnvelopeDto) => Promise<void> | void;
type DataChannelHandler = (peerIdSafe: string, envelope: DataChannelEnvelopeDto) => void;
type BusHandler = (message: LocalWindowBusMessage) => void;

/**
 * Unified bidirectional room session hook managing knocking, discovery probe responses,
 * WebRTC + RTCDataChannel lifecycle, layout/fullscreen/minimize controls, and telemetry.
 */
export const useRoomSession = (options: UseRoomSessionOptions): UseRoomSessionResult => {
  const normalizedHub = normalizeHubTopic(options.hubId);
  const resolvedRole: RoomRole =
    options.role ?? (isHubOwner(options.hubId, options.profile) ? 'owner' : 'guest');
  const localPeerIdSafe = toSafePeerTag(options.profile.nickname, options.profile.peerTag);
  const hostInfo = extractHostFromHub(normalizedHub || options.hubId);
  const waitingForProfile = isWaitingForDefaultProfile(options);

  const [isConnected, setIsConnected] = useState<boolean>(signalingTransport.isConnected);
  const [hasLeftRoom, setHasLeftRoom] = useState<boolean>(false);
  const [sessionNonce, setSessionNonce] = useState<number>(0);
  const [knockStatus, setKnockStatus] = useState<KnockStatus>(
    resolvedRole === 'owner' ? 'accepted' : 'idle'
  );
  const [knockError, setKnockError] = useState<string | null>(null);
  const [entranceAccepted, setEntranceAccepted] = useState<boolean>(resolvedRole === 'owner');
  const [pendingKnocks, setPendingKnocks] = useState<PendingKnock[]>([]);
  const [peers, setPeers] = useState<RoomPeerDto[]>([]);
  const [streams, setStreams] = useState<StreamItem[]>([]);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [isSharing, setIsSharing] = useState<boolean>(false);
  const [fps, setFpsState] = useState<StreamFpsOption>(
    options.profile.preferredFps ?? STREAM_CONFIG.DEFAULT_FPS
  );
  const [isDeafened, setIsDeafened] = useState<boolean>(false);
  const [layoutMode, setLayoutModeState] = useState<WatchLayoutMode>('grid');
  const [spotlightStreamId, setSpotlightStreamId] = useState<string | null>(null);
  const [fullscreenStreamId, setFullscreenStreamId] = useState<string | null>(null);
  const [isMinimized, setIsMinimized] = useState<boolean>(false);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetricsDto>(EMPTY_METRICS);
  const [highLoadSuggestion, setHighLoadSuggestion] = useState<string | null>(null);
  const [connectionFailure, setConnectionFailure] = useState<ConnectionFailureDto | null>(null);

  // Refs keep signaling and WebRTC callbacks decoupled from React render churn.
  const mountedRef = useRef<boolean>(true);
  const profileRef = useRef<UserProfile>(options.profile);
  profileRef.current = options.profile;
  const roleRef = useRef<RoomRole>(resolvedRole);
  roleRef.current = resolvedRole;
  const hubRef = useRef<string>(normalizedHub);
  hubRef.current = normalizedHub;
  const localPeerIdRef = useRef<string>(localPeerIdSafe);
  localPeerIdRef.current = localPeerIdSafe;
  const hostInfoRef = useRef(hostInfo);
  hostInfoRef.current = hostInfo;

  const peersRef = useRef<RoomPeerDto[]>([]);
  const streamsRef = useRef<StreamItem[]>([]);
  const localStreamRef = useRef<MediaStream | null>(null);
  const isSharingRef = useRef<boolean>(false);
  const fpsRef = useRef<StreamFpsOption>(fps);
  const isDeafenedRef = useRef<boolean>(false);
  const isMinimizedRef = useRef<boolean>(false);
  const entranceAcceptedRef = useRef<boolean>(resolvedRole === 'owner');
  const sessionTokenRef = useRef<string>('');
  const hostPeerIdRef = useRef<string>('');
  const preFullscreenLayoutRef = useRef<'grid' | 'spotlight'>('grid');
  const hasAutoStartedRef = useRef<boolean>(false);
  const isChangingFpsRef = useRef<boolean>(false);
  const lastHighLoadRef = useRef<boolean>(false);
  const highLoadDismissedRef = useRef<boolean>(false);
  const dcRttRef = useRef<number>(0);

  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const remoteMetaRef = useRef<Map<string, RemoteStreamMeta>>(new Map());
  const streamVolumesRef = useRef<Map<string, number>>(new Map());
  const knockReplyTopicsRef = useRef<Map<string, string>>(new Map());
  const peerTokensRef = useRef<Map<string, string>>(new Map());
  const knockTimerRef = useRef<number | null>(null);
  const hostOfferTimerRef = useRef<number | null>(null);
  const transientKnockUnsubRef = useRef<(() => void) | null>(null);
  const pendingPreAcceptSignalsRef = useRef<SignalingEnvelopeDto[]>([]);
  const roomUnsubsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setHasLeftRoom(false);
    setIsMinimized(false);
    isMinimizedRef.current = false;
    hasAutoStartedRef.current = false;
    pendingPreAcceptSignalsRef.current = [];
  }, [normalizedHub]);

  const clearKnockTimer = useCallback((): void => {
    if (knockTimerRef.current === null) return;
    window.clearTimeout(knockTimerRef.current);
    knockTimerRef.current = null;
  }, []);

  const buildRemoteStreamItem = useCallback(
    (peerIdSafe: string, mediaStream: MediaStream): StreamItem => {
      const peer = peersRef.current.find((item) => item.peerIdSafe === peerIdSafe);
      const meta = remoteMetaRef.current.get(peerIdSafe);
      const savedVol = streamVolumesRef.current.get(peerIdSafe) ?? 100;
      const fallbackTag =
        peerIdSafe === hostPeerIdRef.current
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
    []
  );

  const syncMinimizedBanner = useCallback((activeStreamsCount: number): void => {
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
  }, []);

  const rebuildStreams = useCallback((): void => {
    const next: StreamItem[] = [];
    const currentLocal = localStreamRef.current;

    if (currentLocal && isSharingRef.current) {
      const selfId = localPeerIdRef.current;
      next.push({
        id: selfId,
        peerIdSafe: selfId,
        name: profileRef.current.nickname,
        tag: formatFullPeerTag(profileRef.current.nickname, profileRef.current.peerTag),
        resolution: STREAM_CONFIG.DEFAULT_RESOLUTION,
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
    setStreams(next);
    setSpotlightStreamId((prev) => (prev && activeIds.has(prev) ? prev : null));
    setFullscreenStreamId((prev) => (prev && activeIds.has(prev) ? prev : null));
  }, [buildRemoteStreamItem, syncMinimizedBanner]);

  const updatePeersList = useCallback(
    (updater: (prev: RoomPeerDto[]) => RoomPeerDto[]): RoomPeerDto[] => {
      const next = updater(peersRef.current);
      peersRef.current = next;
      if (mountedRef.current) setPeers(next);
      return next;
    },
    []
  );

  const setPeerStreamingFlag = useCallback(
    (peerIdSafe: string, streaming: boolean): void => {
      updatePeersList((prev) =>
        prev.map((peer) =>
          peer.peerIdSafe === peerIdSafe ? { ...peer, isStreaming: streaming } : peer
        )
      );
    },
    [updatePeersList]
  );

  const broadcastRoomDataChannel = useCallback(
    (payload: Parameters<typeof webrtcStreamEngine.broadcastDataChannelMessage>[0]): void => {
      const fallbackToken = sessionTokenRef.current || 'room-session';
      webrtcStreamEngine.broadcastDataChannelMessage(payload, fallbackToken);
    },
    []
  );

  const handleLocalTrackEnded = useCallback(
    (event?: Event): void => {
      if (!isSharingRef.current || isChangingFpsRef.current) return;
      const currentTrack = localStreamRef.current?.getVideoTracks()[0];
      if (event?.target && currentTrack && event.target !== currentTrack) return;

      localStreamRef.current = null;
      isSharingRef.current = false;
      if (mountedRef.current) {
        setLocalStream(null);
        setIsSharing(false);
      }
      setPeerStreamingFlag(localPeerIdRef.current, false);
      broadcastRoomDataChannel({ type: 'stream_stopped', peerIdSafe: localPeerIdRef.current });
      void webrtcStreamEngine.renegotiateAllPeers();
      rebuildStreams();
    },
    [broadcastRoomDataChannel, rebuildStreams, setPeerStreamingFlag]
  );

  const startSharing = useCallback(async (): Promise<void> => {
    if (isSharingRef.current) return;
    try {
      const targetFps = fpsRef.current;
      const stream = await webrtcStreamEngine.startScreenCapture(targetFps);
      if (!mountedRef.current) {
        await webrtcStreamEngine.stopScreenCapture();
        return;
      }

      localStreamRef.current = stream;
      isSharingRef.current = true;
      setLocalStream(stream);
      setIsSharing(true);
      setConnectionFailure((prev) => (prev?.stage === 'screen_capture' ? null : prev));

      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.addEventListener('ended', handleLocalTrackEnded, { once: true });
      }

      setPeerStreamingFlag(localPeerIdRef.current, true);
      rebuildStreams();

      const startedPayload: StreamStartedPayload = {
        type: 'stream_started',
        peerIdSafe: localPeerIdRef.current,
        displayName: profileRef.current.nickname,
        avatarUrl: profileRef.current.avatarUrl,
        resolution: STREAM_CONFIG.DEFAULT_RESOLUTION,
        fps: targetFps,
      };

      broadcastRoomDataChannel(startedPayload);
      await webrtcStreamEngine.renegotiateAllPeers();

      void telemetryAdapter.trackEvent('stream_started', {
        role: roleRef.current,
        fps: targetFps,
        peerCountTier: toPeerCountTier(peersRef.current.length),
      });
    } catch (err) {
      if (!mountedRef.current) return;
      setConnectionFailure({
        stage: 'screen_capture',
        reason:
          err instanceof Error && err.message
            ? err.message
            : 'Unable to start screen capture.',
        timestamp: Date.now(),
      });
    }
  }, [broadcastRoomDataChannel, handleLocalTrackEnded, rebuildStreams, setPeerStreamingFlag]);

  const stopSharing = useCallback(async (): Promise<void> => {
    if (!isSharingRef.current && !localStreamRef.current) return;
    const oldTrack = localStreamRef.current?.getVideoTracks()[0];
    if (oldTrack) {
      oldTrack.removeEventListener('ended', handleLocalTrackEnded);
    }

    localStreamRef.current = null;
    isSharingRef.current = false;
    if (mountedRef.current) {
      setLocalStream(null);
      setIsSharing(false);
    }

    await webrtcStreamEngine.stopScreenCapture();
    setPeerStreamingFlag(localPeerIdRef.current, false);
    rebuildStreams();

    broadcastRoomDataChannel({ type: 'stream_stopped', peerIdSafe: localPeerIdRef.current });
    await webrtcStreamEngine.renegotiateAllPeers();

    void telemetryAdapter.trackEvent('stream_stopped', {
      role: roleRef.current,
      fps: fpsRef.current,
      peerCountTier: toPeerCountTier(peersRef.current.length),
    });
  }, [broadcastRoomDataChannel, handleLocalTrackEnded, rebuildStreams, setPeerStreamingFlag]);

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

      if (isSharingRef.current) {
        broadcastRoomDataChannel({
          type: 'stream_started',
          peerIdSafe: localPeerIdRef.current,
          displayName: profileRef.current.nickname,
          avatarUrl: profileRef.current.avatarUrl,
          resolution: STREAM_CONFIG.DEFAULT_RESOLUTION,
          fps: nextFps,
        });
      }

      rebuildStreams();
      void telemetryAdapter.trackEvent('fps_changed', { role: roleRef.current, fps: nextFps });
    },
    [broadcastRoomDataChannel, handleLocalTrackEnded, rebuildStreams]
  );

  const toggleFps = useCallback(async (): Promise<void> => {
    const next: StreamFpsOption =
      fpsRef.current === STREAM_CONFIG.DEFAULT_FPS
        ? STREAM_CONFIG.FALLBACK_FPS
        : STREAM_CONFIG.DEFAULT_FPS;
    await setFps(next);
  }, [setFps]);

  const setStreamVolume = useCallback(
    (streamId: string, volume: number): void => {
      const clamped = Math.max(0, Math.min(100, Math.round(volume)));
      streamVolumesRef.current.set(streamId, clamped);
      rebuildStreams();
    },
    [rebuildStreams]
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
  }, []);

  const restoreHub = useCallback(async (): Promise<void> => {
    isMinimizedRef.current = false;
    setIsMinimized(false);
    if (hubRef.current) {
      await localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
    }
    await restoreStreamWindowTauri();
  }, []);

  const clearHostOfferTimer = useCallback((): void => {
    if (hostOfferTimerRef.current === null) return;
    window.clearTimeout(hostOfferTimerRef.current);
    hostOfferTimerRef.current = null;
  }, []);

  const detachTransientKnockSub = useCallback((): void => {
    if (!transientKnockUnsubRef.current) return;
    transientKnockUnsubRef.current();
    transientKnockUnsubRef.current = null;
  }, []);

  const cleanupTransportSubscriptions = useCallback((): void => {
    clearKnockTimer();
    clearHostOfferTimer();
    detachTransientKnockSub();
    pendingPreAcceptSignalsRef.current = [];
    for (const unsub of roomUnsubsRef.current) {
      unsub();
    }
    roomUnsubsRef.current = [];
  }, [clearHostOfferTimer, clearKnockTimer, detachTransientKnockSub]);

  const publishSignalToPeer = useCallback(
    async (remotePeerIdSafe: string, payload: SignalingPayload): Promise<void> => {
      const targetHub = hubRef.current;
      if (!targetHub) return;
      const targetTopic = getGuestInboxTopic(targetHub, remotePeerIdSafe);
      if (!targetTopic) return;
      const envelope = createSignalingEnvelope(targetHub, localPeerIdRef.current, payload);
      await signalingTransport.publish(targetTopic, envelope);
    },
    []
  );

  const resetRoomSessionState = useCallback((): void => {
    void webrtcStreamEngine.stopScreenCapture();
    webrtcStreamEngine.closeAllPeers();
    cleanupTransportSubscriptions();

    localStreamRef.current = null;
    isSharingRef.current = false;
    remoteStreamsRef.current.clear();
    remoteMetaRef.current.clear();
    peerTokensRef.current.clear();
    knockReplyTopicsRef.current.clear();
    pendingPreAcceptSignalsRef.current = [];
    peersRef.current = [];
    streamsRef.current = [];
    sessionTokenRef.current = '';
    hostPeerIdRef.current = '';
    hasAutoStartedRef.current = false;
    isMinimizedRef.current = false;

    if (!mountedRef.current) return;
    setLocalStream(null);
    setIsSharing(false);
    setIsMinimized(false);
    setConnectionFailure(null);
    setPendingKnocks([]);
    setPeers([]);
    setStreams([]);
  }, [cleanupTransportSubscriptions]);

  const leaveRoom = useCallback(async (): Promise<void> => {
    const notifyTargets = new Set<string>();
    for (const peer of peersRef.current) {
      if (peer.peerIdSafe && peer.peerIdSafe !== localPeerIdRef.current) {
        notifyTargets.add(peer.peerIdSafe);
      }
    }
    if (hostPeerIdRef.current && hostPeerIdRef.current !== localPeerIdRef.current) {
      notifyTargets.add(hostPeerIdRef.current);
    }

    broadcastRoomDataChannel({ type: 'peer_left', peerIdSafe: localPeerIdRef.current });
    for (const peerId of notifyTargets) {
      void publishSignalToPeer(peerId, {
        type: 'peer_left',
        peerIdSafe: localPeerIdRef.current,
      });
    }

    await stopSharing();
    resetRoomSessionState();

    if (mountedRef.current) {
      setHasLeftRoom(true);
    }

    if (hubRef.current) {
      await localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
    }
  }, [broadcastRoomDataChannel, publishSignalToPeer, resetRoomSessionState, stopSharing]);

  const rejoinRoom = useCallback((): void => {
    resetRoomSessionState();
    entranceAcceptedRef.current = roleRef.current === 'owner';
    setHasLeftRoom(false);
    setKnockError(null);
    setConnectionFailure(null);
    setKnockStatus(roleRef.current === 'owner' ? 'accepted' : 'idle');
    setEntranceAccepted(roleRef.current === 'owner');
    setSessionNonce((n) => n + 1);
  }, [resetRoomSessionState]);

  const dismissConnectionFailure = useCallback((): void => {
    setConnectionFailure(null);
  }, []);

  const retryConnection = useCallback((): void => {
    setConnectionFailure(null);
    rejoinRoom();
  }, [rejoinRoom]);

  const dismissHighLoadSuggestion = useCallback((): void => {
    highLoadDismissedRef.current = true;
    setHighLoadSuggestion(null);
  }, []);

  const cleanupExistingPeerConnection = useCallback(
    (peerIdSafe: string, removeFromRoster = false): boolean => {
      if (!peerIdSafe || peerIdSafe === localPeerIdRef.current) return false;
      const inRoster = peersRef.current.some((peer) => peer.peerIdSafe === peerIdSafe);
      const hasEnginePeer = webrtcStreamEngine.hasPeer(peerIdSafe);
      const hasStream = remoteStreamsRef.current.has(peerIdSafe);
      const hasMeta = remoteMetaRef.current.has(peerIdSafe);
      const hasToken = peerTokensRef.current.has(peerIdSafe);
      const hadConnection = inRoster || hasEnginePeer || hasStream || hasMeta || hasToken;

      webrtcStreamEngine.closePeer(peerIdSafe);
      remoteStreamsRef.current.delete(peerIdSafe);
      remoteMetaRef.current.delete(peerIdSafe);
      peerTokensRef.current.delete(peerIdSafe);

      if (removeFromRoster && inRoster) {
        updatePeersList((prev) => prev.filter((item) => item.peerIdSafe !== peerIdSafe));
        rebuildStreams();
      } else if (hasStream) {
        rebuildStreams();
      }

      return hadConnection;
    },
    [rebuildStreams, updatePeersList]
  );

  const connectMeshPeersFromRoster = useCallback(
    (roster: RoomPeerDto[]): void => {
      if (roleRef.current !== 'guest' || !hubRef.current) return;
      const myId = localPeerIdRef.current;

      for (const peer of roster) {
        if (peer.peerIdSafe === myId || peer.peerIdSafe === hostPeerIdRef.current) continue;
        if (webrtcStreamEngine.hasPeer(peer.peerIdSafe)) {
          if (webrtcStreamEngine.isPeerHealthy(peer.peerIdSafe)) continue;
          cleanupExistingPeerConnection(peer.peerIdSafe, false);
        }
        if (myId.localeCompare(peer.peerIdSafe) >= 0) continue;

        const meshToken = getMeshTokenForPair(hubRef.current, myId, peer.peerIdSafe);
        peerTokensRef.current.set(peer.peerIdSafe, meshToken);
        webrtcStreamEngine.registerPeerSessionToken(peer.peerIdSafe, meshToken);
        void webrtcStreamEngine.initiatePeerConnection(peer.peerIdSafe, meshToken);
      }
    },
    [cleanupExistingPeerConnection]
  );

  const handleAcceptKnockAction = useCallback(
    async (knock: PendingKnock): Promise<void> => {
      if (roleRef.current !== 'owner' || !hubRef.current) return;
      setPendingKnocks((prev) => prev.filter((item) => item.peerIdSafe !== knock.peerIdSafe));

      const replyTopic =
        knockReplyTopicsRef.current.get(knock.peerIdSafe) ||
        getGuestInboxTopic(hubRef.current, knock.peerIdSafe);

      const effectivePeerCount = peersRef.current.filter(
        (peer) => peer.peerIdSafe !== knock.peerIdSafe
      ).length;

      if (!canAcceptMorePeers(effectivePeerCount)) {
        const denyEnvelope = createSignalingEnvelope<KnockDecisionPayload>(
          hubRef.current,
          localPeerIdRef.current,
          {
            type: 'knock_decision',
            accepted: false,
            sessionToken: '',
            peerRoster: [],
            hostPeerIdSafe: localPeerIdRef.current,
            hostDisplayName: profileRef.current.nickname,
            reason: `Room is full (max ${ROOM_CONFIG.MAX_CONCURRENT_PEERS} peers).`,
          }
        );
        await signalingTransport.publish(replyTopic, denyEnvelope);
        return;
      }

      cleanupExistingPeerConnection(knock.peerIdSafe, true);

      const sessionToken = createUniqueId('sess');
      peerTokensRef.current.set(knock.peerIdSafe, sessionToken);
      webrtcStreamEngine.registerPeerSessionToken(knock.peerIdSafe, sessionToken);

      const newPeer: RoomPeerDto = {
        peerIdSafe: knock.peerIdSafe,
        peerTag: knock.peerTag,
        displayName: knock.displayName,
        avatarUrl: knock.avatarUrl || '',
        role: 'guest',
        isStreaming: false,
        joinedAt: Date.now(),
      };

      const nextRoster = updatePeersList((prev) => [
        ...prev.filter((item) => item.peerIdSafe !== knock.peerIdSafe),
        newPeer,
      ]);

      const acceptEnvelope = createSignalingEnvelope<KnockDecisionPayload>(
        hubRef.current,
        localPeerIdRef.current,
        {
          type: 'knock_decision',
          accepted: true,
          sessionToken,
          peerRoster: nextRoster,
          hostPeerIdSafe: localPeerIdRef.current,
          hostDisplayName: profileRef.current.nickname,
        }
      );

      await signalingTransport.publish(replyTopic, acceptEnvelope);
      broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });

      void telemetryAdapter.trackEvent('knock_accepted', {
        role: 'owner',
        peerCountTier: toPeerCountTier(nextRoster.length),
      });

      await Promise.resolve();
      await webrtcStreamEngine.initiatePeerConnection(knock.peerIdSafe, sessionToken);
    },
    [broadcastRoomDataChannel, cleanupExistingPeerConnection, updatePeersList]
  );

  const handleRejectKnockAction = useCallback(async (knock: PendingKnock): Promise<void> => {
    if (roleRef.current !== 'owner' || !hubRef.current) return;
    setPendingKnocks((prev) => prev.filter((item) => item.peerIdSafe !== knock.peerIdSafe));

    const replyTopic =
      knockReplyTopicsRef.current.get(knock.peerIdSafe) ||
      getGuestInboxTopic(hubRef.current, knock.peerIdSafe);

    const rejectEnvelope = createSignalingEnvelope<KnockDecisionPayload>(
      hubRef.current,
      localPeerIdRef.current,
      {
        type: 'knock_decision',
        accepted: false,
        sessionToken: '',
        peerRoster: [],
        hostPeerIdSafe: localPeerIdRef.current,
        hostDisplayName: profileRef.current.nickname,
        reason: 'Host declined your entrance request.',
      }
    );

    await signalingTransport.publish(replyTopic, rejectEnvelope);
  }, []);

  const persistJoinedFriendHub = useCallback(
    async (hubTopic: string, payload: KnockDecisionPayload): Promise<void> => {
      try {
        const existingHubs = await storageRepository.listFriendHubs();
        const existing = existingHubs.find(
          (item) => normalizeHubTopic(item.hubId) === hubTopic
        );
        const hostPeer = payload.peerRoster.find(
          (peer) => peer.peerIdSafe === payload.hostPeerIdSafe
        );
        const parsedHost = extractHostFromHub(hubTopic);

        await storageRepository.upsertFriendHub({
          hubId: hubTopic,
          ownerNickname: payload.hostDisplayName || parsedHost.displayName,
          ownerTag: hostPeer?.peerTag || parsedHost.tag,
          ownerAvatar: hostPeer?.avatarUrl || '',
          lastJoinedAt: Date.now(),
          isFavorite: existing?.isFavorite ?? false,
        });
      } catch (err) {
        console.warn('[useRoomSession] Failed to save Friend Hub:', err);
      }
    },
    []
  );

  const verifyAndRegisterOfferToken = useCallback(
    (fromPeerIdSafe: string, sessionToken: string): boolean => {
      if (!fromPeerIdSafe || !sessionToken || !hubRef.current) return false;

      if (roleRef.current === 'owner') {
        return peerTokensRef.current.get(fromPeerIdSafe) === sessionToken;
      }

      if (!entranceAcceptedRef.current) return false;

      if (fromPeerIdSafe === hostPeerIdRef.current) {
        if (!sessionTokenRef.current || sessionToken !== sessionTokenRef.current) return false;
        peerTokensRef.current.set(fromPeerIdSafe, sessionToken);
        webrtcStreamEngine.registerPeerSessionToken(fromPeerIdSafe, sessionToken);
        return true;
      }

      const isKnownPeer = peersRef.current.some((peer) => peer.peerIdSafe === fromPeerIdSafe);
      if (!isKnownPeer) return false;

      const expectedMeshToken = getMeshTokenForPair(
        hubRef.current,
        localPeerIdRef.current,
        fromPeerIdSafe
      );
      if (sessionToken !== expectedMeshToken) return false;

      peerTokensRef.current.set(fromPeerIdSafe, sessionToken);
      webrtcStreamEngine.registerPeerSessionToken(fromPeerIdSafe, sessionToken);
      return true;
    },
    []
  );

  const bufferPreAcceptSignal = useCallback((envelope: SignalingEnvelopeDto): void => {
    if (pendingPreAcceptSignalsRef.current.length >= 64) {
      pendingPreAcceptSignalsRef.current.shift();
    }
    pendingPreAcceptSignalsRef.current.push(envelope);
  }, []);

  const processOfferEnvelope = useCallback(
    (envelope: SignalingEnvelopeDto): Promise<void> | void => {
      if (envelope.payload.type !== 'webrtc_offer') return;
      if (roleRef.current === 'guest' && !entranceAcceptedRef.current) {
        bufferPreAcceptSignal(envelope);
        return;
      }
      const { fromPeerIdSafe, sdp, sessionToken } = envelope.payload;
      if (!verifyAndRegisterOfferToken(fromPeerIdSafe, sessionToken)) return;
      if (fromPeerIdSafe === hostPeerIdRef.current) {
        clearHostOfferTimer();
      }
      return webrtcStreamEngine.handleIncomingOffer(fromPeerIdSafe, sdp, sessionToken);
    },
    [bufferPreAcceptSignal, clearHostOfferTimer, verifyAndRegisterOfferToken]
  );

  const processIceEnvelope = useCallback(
    (envelope: SignalingEnvelopeDto): Promise<void> | void => {
      if (envelope.payload.type !== 'webrtc_ice') return;
      if (roleRef.current === 'guest' && !entranceAcceptedRef.current) {
        bufferPreAcceptSignal(envelope);
        return;
      }
      const { fromPeerIdSafe, candidate, sessionToken } = envelope.payload;
      const validToken =
        peerTokensRef.current.get(fromPeerIdSafe) === sessionToken ||
        verifyAndRegisterOfferToken(fromPeerIdSafe, sessionToken);
      if (!validToken) return;
      return webrtcStreamEngine.handleIncomingIce(fromPeerIdSafe, candidate, sessionToken);
    },
    [bufferPreAcceptSignal, verifyAndRegisterOfferToken]
  );

  const handleKnockDecision = useCallback(
    async (envelope: SignalingEnvelopeDto): Promise<void> => {
      if (roleRef.current !== 'guest') return;
      if (envelope.payload.type !== 'knock_decision') return;
      const payload = envelope.payload;
      clearKnockTimer();
      clearHostOfferTimer();

      if (!payload.accepted) {
        pendingPreAcceptSignalsRef.current = [];
        entranceAcceptedRef.current = false;
        setEntranceAccepted(false);
        setKnockStatus('rejected');
        setKnockError(payload.reason || 'Host declined your entrance request.');
        return;
      }

      cleanupExistingPeerConnection(payload.hostPeerIdSafe, false);
      for (const peer of payload.peerRoster) {
        if (peer.peerIdSafe === payload.hostPeerIdSafe) continue;
        cleanupExistingPeerConnection(peer.peerIdSafe, false);
      }

      sessionTokenRef.current = payload.sessionToken;
      hostPeerIdRef.current = payload.hostPeerIdSafe;
      peerTokensRef.current.set(payload.hostPeerIdSafe, payload.sessionToken);
      webrtcStreamEngine.registerPeerSessionToken(payload.hostPeerIdSafe, payload.sessionToken);

      entranceAcceptedRef.current = true;
      setEntranceAccepted(true);
      setKnockStatus('accepted');
      setKnockError(null);
      updatePeersList(() => payload.peerRoster);

      const bufferedSignals = pendingPreAcceptSignalsRef.current.splice(0);
      const bufferedOffers = bufferedSignals.filter((sig) => sig.payload.type === 'webrtc_offer');
      const bufferedIce = bufferedSignals.filter((sig) => sig.payload.type === 'webrtc_ice');
      for (const sig of [...bufferedOffers, ...bufferedIce]) {
        if (sig.payload.type === 'webrtc_offer') {
          await processOfferEnvelope(sig);
          continue;
        }
        await processIceEnvelope(sig);
      }

      const receivedHostOffer = bufferedOffers.some(
        (sig) => sig.payload.type === 'webrtc_offer' && sig.payload.fromPeerIdSafe === payload.hostPeerIdSafe
      );
      if (!receivedHostOffer) {
        hostOfferTimerRef.current = window.setTimeout(() => {
          hostOfferTimerRef.current = null;
          if (!mountedRef.current) return;
          if (webrtcStreamEngine.getConnectedPeerIds().includes(payload.hostPeerIdSafe)) return;
          setConnectionFailure({
            stage: 'sdp_handshake',
            reason: 'Accepted by host, but did not receive the WebRTC stream offer from host.',
            details: `host=${payload.hostPeerIdSafe}, hub=${hubRef.current}`,
            peerIdSafe: payload.hostPeerIdSafe,
            timestamp: Date.now(),
          });
        }, 8000);
      }

      connectMeshPeersFromRoster(payload.peerRoster);

      if (hubRef.current) {
        await persistJoinedFriendHub(hubRef.current, payload);
      }

      void telemetryAdapter.trackEvent('room_joined', {
        role: 'guest',
        peerCountTier: toPeerCountTier(payload.peerRoster.length),
      });
    },
    [
      cleanupExistingPeerConnection,
      clearHostOfferTimer,
      clearKnockTimer,
      connectMeshPeersFromRoster,
      persistJoinedFriendHub,
      processIceEnvelope,
      processOfferEnvelope,
      updatePeersList,
    ]
  );

  const handleProbeRequest = useCallback(async (envelope: SignalingEnvelopeDto): Promise<void> => {
    if (roleRef.current !== 'owner' || !hubRef.current) return;
    if (envelope.payload.type !== 'hub_status_request') return;

    const streamingPeers = peersRef.current.filter((peer) => peer.isStreaming);
    const streamerNames = streamingPeers.map((peer) => peer.displayName);
    const isBroadcasting = streamerNames.length > 0 || isSharingRef.current;
    if (isSharingRef.current && !streamerNames.includes(profileRef.current.nickname)) {
      streamerNames.unshift(profileRef.current.nickname);
    }

    const replyTopic =
      envelope.payload.replyTopic ||
      getGuestInboxTopic(hubRef.current, envelope.payload.requesterIdSafe);
    if (!replyTopic) return;

    const response = createSignalingEnvelope<HubStatusResponsePayload>(
      hubRef.current,
      localPeerIdRef.current,
      {
        type: 'hub_status_response',
        requestId: envelope.payload.requestId,
        hubId: hubRef.current,
        status: isBroadcasting ? 'broadcasting' : 'online',
        peers: peersRef.current.length,
        streamerNames,
        respondedAt: Date.now(),
      }
    );

    await signalingTransport.publish(replyTopic, response);
  }, []);

  const handleIncomingKnockRequest = useCallback(async (envelope: SignalingEnvelopeDto): Promise<void> => {
    if (roleRef.current !== 'owner' || !hubRef.current) return;
    if (envelope.payload.type !== 'knock_request') return;

    const payload = envelope.payload;
    if (payload.peerIdSafe === localPeerIdRef.current) return;

    const effectivePeerCount = peersRef.current.filter(
      (peer) => peer.peerIdSafe !== payload.peerIdSafe
    ).length;

    if (!canAcceptMorePeers(effectivePeerCount)) {
      const denyEnvelope = createSignalingEnvelope<KnockDecisionPayload>(
        hubRef.current,
        localPeerIdRef.current,
        {
          type: 'knock_decision',
          accepted: false,
          sessionToken: '',
          peerRoster: [],
          hostPeerIdSafe: localPeerIdRef.current,
          hostDisplayName: profileRef.current.nickname,
          reason: `Room is full (max ${ROOM_CONFIG.MAX_CONCURRENT_PEERS} peers).`,
        }
      );
      await signalingTransport.publish(payload.replyTopic, denyEnvelope);
      return;
    }

    knockReplyTopicsRef.current.set(payload.peerIdSafe, payload.replyTopic);
    const knockItem: PendingKnock = {
      id: `k_${payload.peerIdSafe}_${envelope.sentAt}`,
      peerTag: payload.peerTag,
      peerIdSafe: payload.peerIdSafe,
      displayName: payload.displayName,
      avatarUrl: payload.avatarUrl,
      timestamp: envelope.sentAt,
      hubTopic: hubRef.current,
    };

    setPendingKnocks((prev) => [
      knockItem,
      ...prev.filter((item) => item.peerIdSafe !== payload.peerIdSafe),
    ]);
  }, []);

  const sendKnockRequest = useCallback(async (): Promise<void> => {
    const targetHub = hubRef.current;
    if (!targetHub || roleRef.current !== 'guest') return;

    const knockTopic = getKnockTopic(targetHub);
    const guestInbox = getGuestInboxTopic(targetHub, localPeerIdRef.current);
    const knockReplyTopic = `${guestInbox}/knock`;
    if (!knockTopic || !guestInbox) return;

    clearKnockTimer();
    setKnockError(null);
    setKnockStatus('knocking');
    setEntranceAccepted(false);
    entranceAcceptedRef.current = false;

    detachTransientKnockSub();
    transientKnockUnsubRef.current = await signalingTransport.subscribeTopic(
      knockReplyTopic,
      (envelope) => {
        void handleKnockDecision(envelope);
      }
    );

    const requestEnvelope = createSignalingEnvelope<KnockRequestPayload>(
      targetHub,
      localPeerIdRef.current,
      {
        type: 'knock_request',
        peerTag: formatFullPeerTag(profileRef.current.nickname, profileRef.current.peerTag),
        peerIdSafe: localPeerIdRef.current,
        displayName: profileRef.current.nickname,
        avatarUrl: profileRef.current.avatarUrl,
        replyTopic: knockReplyTopic,
      }
    );

    await signalingTransport.publish(knockTopic, requestEnvelope);

    knockTimerRef.current = window.setTimeout(() => {
      if (!mountedRef.current || entranceAcceptedRef.current) return;
      setKnockStatus('timeout');
    }, KNOCK_TIMEOUT_MS);
  }, [clearKnockTimer, detachTransientKnockSub, handleKnockDecision]);

  const cancelKnock = useCallback((): void => {
    clearKnockTimer();
    detachTransientKnockSub();
    setKnockStatus('idle');
  }, [clearKnockTimer, detachTransientKnockSub]);

  const handlePeerLeftDataChannel = useCallback(
    (leftId: string): void => {
      if (!leftId || leftId === localPeerIdRef.current) return;

      if (roleRef.current === 'guest' && leftId === hostPeerIdRef.current) {
        webrtcStreamEngine.closeAllPeers();
        remoteStreamsRef.current.clear();
        remoteMetaRef.current.clear();
        peerTokensRef.current.clear();
        sessionTokenRef.current = '';
        hostPeerIdRef.current = '';
        entranceAcceptedRef.current = false;
        updatePeersList(() => []);
        rebuildStreams();
        if (mountedRef.current) {
          setEntranceAccepted(false);
          setKnockStatus('idle');
          setKnockError('Host left the room. Knock again when they return.');
        }
        return;
      }

      remoteStreamsRef.current.delete(leftId);
      remoteMetaRef.current.delete(leftId);
      peerTokensRef.current.delete(leftId);
      webrtcStreamEngine.closePeer(leftId);
      const nextRoster = updatePeersList((prev) =>
        prev.filter((item) => item.peerIdSafe !== leftId)
      );
      if (roleRef.current === 'owner') {
        broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
      }
      rebuildStreams();
    },
    [broadcastRoomDataChannel, rebuildStreams, updatePeersList]
  );

  const handleDataChannelOpenCallback = useCallback(
    (peerIdSafe: string): void => {
      const token =
        peerTokensRef.current.get(peerIdSafe) || sessionTokenRef.current || 'room-session';
      if (roleRef.current === 'guest' && peerIdSafe === hostPeerIdRef.current) {
        clearHostOfferTimer();
        detachTransientKnockSub();
      }
      if (mountedRef.current) {
        setConnectionFailure(null);
      }
      if (roleRef.current === 'owner') {
        webrtcStreamEngine.sendDataChannelMessage(
          peerIdSafe,
          { type: 'peer_roster_sync', peers: peersRef.current },
          token
        );
      }
      if (isSharingRef.current) {
        webrtcStreamEngine.sendDataChannelMessage(
          peerIdSafe,
          {
            type: 'stream_started',
            peerIdSafe: localPeerIdRef.current,
            displayName: profileRef.current.nickname,
            avatarUrl: profileRef.current.avatarUrl,
            resolution: STREAM_CONFIG.DEFAULT_RESOLUTION,
            fps: fpsRef.current,
          },
          token
        );
      }
      webrtcStreamEngine.sendDataChannelMessage(
        peerIdSafe,
        { type: 'ping', sentAt: Date.now() },
        token
      );
    },
    [clearHostOfferTimer, detachTransientKnockSub]
  );

  const handlePeerStateChangeCallback = useCallback(
    (peerIdSafe: string, state: RTCPeerConnectionState): void => {
      if (state !== 'failed' && state !== 'closed') return;
      remoteStreamsRef.current.delete(peerIdSafe);
      if (roleRef.current === 'owner') {
        const nextRoster = updatePeersList((prev) =>
          prev.filter((item) => item.peerIdSafe !== peerIdSafe)
        );
        broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
      }
      rebuildStreams();
    },
    [broadcastRoomDataChannel, rebuildStreams, updatePeersList]
  );

  const createDcDispatchMap = useCallback((): Record<DataChannelMessageType, DataChannelHandler> => {
    return {
      peer_roster_sync: (_peerId, env) => {
        if (env.payload.type !== 'peer_roster_sync') return;
        const roster = env.payload.peers;
        const existingById = new Map(
          peersRef.current.map((item) => [item.peerIdSafe, item])
        );
        for (const peer of roster) {
          if (peer.peerIdSafe === localPeerIdRef.current || peer.peerIdSafe === hostPeerIdRef.current) {
            continue;
          }
          const existingPeer = existingById.get(peer.peerIdSafe);
          const staleOrReplaced =
            (existingPeer && peer.joinedAt > existingPeer.joinedAt) ||
            (webrtcStreamEngine.hasPeer(peer.peerIdSafe) &&
              !webrtcStreamEngine.isPeerHealthy(peer.peerIdSafe));
          if (staleOrReplaced) {
            cleanupExistingPeerConnection(peer.peerIdSafe, false);
          }
        }
        updatePeersList(() => roster);
        connectMeshPeersFromRoster(roster);
        rebuildStreams();
      },
      stream_started: (_peerId, env) => {
        if (env.payload.type !== 'stream_started') return;
        const p = env.payload;
        remoteMetaRef.current.set(p.peerIdSafe, {
          resolution: p.resolution,
          fps: p.fps,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
        });
        setPeerStreamingFlag(p.peerIdSafe, true);
        rebuildStreams();
      },
      stream_stopped: (_peerId, env) => {
        if (env.payload.type !== 'stream_stopped') return;
        remoteMetaRef.current.delete(env.payload.peerIdSafe);
        remoteStreamsRef.current.delete(env.payload.peerIdSafe);
        setPeerStreamingFlag(env.payload.peerIdSafe, false);
        rebuildStreams();
      },
      renegotiate_offer: () => {},
      renegotiate_answer: () => {},
      renegotiate_ice: () => {},
      peer_left: (_peerId, env) => {
        if (env.payload.type !== 'peer_left') return;
        handlePeerLeftDataChannel(env.payload.peerIdSafe);
      },
      ping: () => {},
      pong: (_peerId, env) => {
        if (env.payload.type !== 'pong') return;
        const measured = Math.max(1, Date.now() - env.payload.echoSentAt);
        dcRttRef.current = measured;
        if (mountedRef.current) {
          setSystemMetrics((prev) => ({ ...prev, rttMs: prev.rttMs > 0 ? prev.rttMs : measured }));
        }
      },
    };
  }, [
    cleanupExistingPeerConnection,
    connectMeshPeersFromRoster,
    handlePeerLeftDataChannel,
    rebuildStreams,
    setPeerStreamingFlag,
    updatePeersList,
  ]);

  const configureStreamEngine = useCallback((): void => {
    const dcHandlers = createDcDispatchMap();
    const callbacks: StreamEngineCallbacks = {
      onRemoteStream: (peerIdSafe, stream) => {
        if (peerIdSafe === hostPeerIdRef.current) {
          clearHostOfferTimer();
        }
        if (mountedRef.current) {
          setConnectionFailure(null);
        }
        remoteStreamsRef.current.set(peerIdSafe, stream);
        setPeerStreamingFlag(peerIdSafe, true);
        rebuildStreams();
      },
      onRemoteStreamRemoved: (peerIdSafe) => {
        remoteStreamsRef.current.delete(peerIdSafe);
        setPeerStreamingFlag(peerIdSafe, false);
        rebuildStreams();
      },
      onPeerConnectionStateChange: handlePeerStateChangeCallback,
      onPeerConnectionError: (failure) => {
        if (!mountedRef.current) return;
        setConnectionFailure(failure);
      },
      onDataChannelOpen: handleDataChannelOpenCallback,
      onDataChannelMessage: (peerIdSafe, envelope) => {
        dcHandlers[envelope.payload.type](peerIdSafe, envelope);
      },
      onSignalOffer: (peerIdSafe, sdp, sessionToken) =>
        publishSignalToPeer(peerIdSafe, {
          type: 'webrtc_offer',
          sessionToken,
          fromPeerIdSafe: localPeerIdRef.current,
          replyTopic: getGuestInboxTopic(hubRef.current, localPeerIdRef.current),
          sdp,
        }),
      onSignalAnswer: (peerIdSafe, sdp, sessionToken) =>
        publishSignalToPeer(peerIdSafe, {
          type: 'webrtc_answer',
          sessionToken,
          fromPeerIdSafe: localPeerIdRef.current,
          sdp,
        }),
      onSignalIce: (peerIdSafe, candidate, sessionToken) =>
        publishSignalToPeer(peerIdSafe, {
          type: 'webrtc_ice',
          sessionToken,
          fromPeerIdSafe: localPeerIdRef.current,
          candidate,
        }),
    };

    webrtcStreamEngine.configure(localPeerIdRef.current, callbacks);
  }, [
    createDcDispatchMap,
    handleDataChannelOpenCallback,
    handlePeerStateChangeCallback,
    publishSignalToPeer,
    rebuildStreams,
    setPeerStreamingFlag,
  ]);

  const createSignalingDispatchMap = useCallback((): Record<SignalingMessageType, SignalingHandler> => {
    return {
      hub_status_request: (env) => handleProbeRequest(env),
      hub_status_response: () => {},
      knock_request: (env) => handleIncomingKnockRequest(env),
      knock_decision: (env) => handleKnockDecision(env),
      webrtc_offer: (env) => processOfferEnvelope(env),
      webrtc_answer: (env) => {
        if (env.payload.type !== 'webrtc_answer') return;
        const { fromPeerIdSafe, sdp, sessionToken } = env.payload;
        if (peerTokensRef.current.get(fromPeerIdSafe) !== sessionToken) return;
        return webrtcStreamEngine.handleIncomingAnswer(fromPeerIdSafe, sdp, sessionToken);
      },
      webrtc_ice: (env) => processIceEnvelope(env),
      peer_left: (env) => {
        if (env.payload.type !== 'peer_left') return;
        handlePeerLeftDataChannel(env.payload.peerIdSafe);
      },
    };
  }, [
    handleIncomingKnockRequest,
    handleKnockDecision,
    handlePeerLeftDataChannel,
    handleProbeRequest,
    processIceEnvelope,
    processOfferEnvelope,
  ]);

  // Main stable room lifecycle effect — keyed strictly on primitive identity & hub values.
  useEffect(() => {
    if (!normalizedHub || waitingForProfile || hasLeftRoom) return;

    let cancelled = false;
    configureStreamEngine();
    const signalingHandlers = createSignalingDispatchMap();

    const dispatchSignaling = (envelope: SignalingEnvelopeDto): void => {
      if (envelope.senderPeerIdSafe === localPeerIdRef.current) return;
      void signalingHandlers[envelope.payload.type](envelope);
    };

    const unsubConn = signalingTransport.onConnectionChange((connected) => {
      if (!mountedRef.current) return;
      setIsConnected(connected);
      if (connected) {
        setConnectionFailure((prev) => (prev?.stage === 'signaling_broker' ? null : prev));
      }
    });
    roomUnsubsRef.current.push(unsubConn);

    const initializeSession = async (): Promise<void> => {
      await signalingTransport.connect();
      if (cancelled) return;
      const connectedNow = signalingTransport.isConnected;
      setIsConnected(connectedNow);
      if (!connectedNow) {
        setConnectionFailure({
          stage: 'signaling_broker',
          reason:
            'Unable to reach the MQTT signaling broker. Check your internet connection or firewall.',
          details: `hub=${normalizedHub}`,
          timestamp: Date.now(),
        });
      }

      const inboxTopic = getGuestInboxTopic(normalizedHub, localPeerIdSafe);
      const unsubInbox = await signalingTransport.subscribeTopic(inboxTopic, dispatchSignaling);
      if (cancelled) {
        unsubInbox();
        return;
      }
      roomUnsubsRef.current.push(unsubInbox);

      if (resolvedRole !== 'owner') {
        entranceAcceptedRef.current = false;
        setEntranceAccepted(false);
        await sendKnockRequest();
        return;
      }

      entranceAcceptedRef.current = true;
      setEntranceAccepted(true);
      setKnockStatus('accepted');
      updatePeersList(() => [
        createSelfPeer(profileRef.current, localPeerIdSafe, 'owner', isSharingRef.current),
      ]);

      const unsubKnock = await signalingTransport.subscribeTopic(
        getKnockTopic(normalizedHub),
        dispatchSignaling
      );
      const unsubProbe = await signalingTransport.subscribeTopic(
        getProbeTopic(normalizedHub),
        dispatchSignaling
      );
      if (cancelled) {
        unsubKnock();
        unsubProbe();
        return;
      }
      roomUnsubsRef.current.push(unsubKnock, unsubProbe);

      void telemetryAdapter.trackEvent('room_joined', { role: 'owner', peerCountTier: '1' });
      if (options.autoStart && !hasAutoStartedRef.current) {
        hasAutoStartedRef.current = true;
        void startSharing();
      }
    };

    void initializeSession();

    const handleBeforeUnload = (): void => {
      broadcastRoomDataChannel({ type: 'peer_left', peerIdSafe: localPeerIdRef.current });
      if (hubRef.current) {
        void localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      cancelled = true;
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanupTransportSubscriptions();
      void webrtcStreamEngine.stopScreenCapture();
      webrtcStreamEngine.closeAllPeers();
      localStreamRef.current = null;
      isSharingRef.current = false;
      remoteStreamsRef.current.clear();
      remoteMetaRef.current.clear();
      if (mountedRef.current) {
        setLocalStream(null);
        setIsSharing(false);
      }
    };
  }, [
    broadcastRoomDataChannel,
    cleanupTransportSubscriptions,
    configureStreamEngine,
    createSignalingDispatchMap,
    hasLeftRoom,
    localPeerIdSafe,
    normalizedHub,
    options.autoStart,
    resolvedRole,
    sendKnockRequest,
    sessionNonce,
    startSharing,
    updatePeersList,
    waitingForProfile,
  ]);

  // Listen on localWindowBus for restore / disconnect commands targeting this hub.
  useEffect(() => {
    const busHandlers: Record<LocalWindowBusMessageType, BusHandler> = {
      profile_updated: () => {},
      minimized_hub_updated: () => {},
      minimized_hub_cleared: () => {},
      restore_hub_requested: (msg) => {
        if (msg.type !== 'restore_hub_requested') return;
        if (normalizeHubTopic(msg.hubId) !== hubRef.current) return;
        void restoreHub();
      },
      disconnect_hub_requested: (msg) => {
        if (msg.type !== 'disconnect_hub_requested') return;
        if (normalizeHubTopic(msg.hubId) !== hubRef.current) return;
        void leaveRoom();
      },
    };

    return localWindowBus.subscribe((message) => {
      busHandlers[message.type](message);
    });
  }, [leaveRoom, restoreHub]);

  const sampleSystemMetricsOnce = useCallback(async (): Promise<void> => {
    const evictedPeers = webrtcStreamEngine.pingAndCleanupPeers();
    const now = Date.now();
    const orphanedPeers = peersRef.current
      .filter((peer) => {
        if (peer.peerIdSafe === localPeerIdRef.current) return false;
        if (roleRef.current === 'guest' && peer.peerIdSafe === hostPeerIdRef.current) return false;
        if (now - peer.joinedAt <= 12000) return false;
        return !webrtcStreamEngine.hasPeer(peer.peerIdSafe);
      })
      .map((peer) => peer.peerIdSafe);

    for (const stalePeerId of new Set([...evictedPeers, ...orphanedPeers])) {
      handlePeerLeftDataChannel(stalePeerId);
    }

    const sampled = await systemMonitorAdapter.sampleMetrics(webrtcStreamEngine);
    if (!mountedRef.current) return;

    const effectiveRtt = sampled.rttMs > 0 ? sampled.rttMs : dcRttRef.current;
    const merged: SystemMetricsDto = { ...sampled, rttMs: effectiveRtt };
    setSystemMetrics(merged);

    if (merged.highLoadWarning && !lastHighLoadRef.current) {
      highLoadDismissedRef.current = false;
      void telemetryAdapter.trackEvent('high_load_detected', {
        role: roleRef.current,
        fps: fpsRef.current,
        cpuTier: toCpuTier(merged.cpuUsagePercent),
        ramTier: toRamTier(merged.memoryUsedMb, merged.memoryTotalMb),
        rttBucket: toRttBucket(effectiveRtt),
      });
    }
    lastHighLoadRef.current = merged.highLoadWarning;

    if (!merged.highLoadWarning) {
      setHighLoadSuggestion(null);
      return;
    }

    if (highLoadDismissedRef.current) return;
    const advice =
      fpsRef.current === 60
        ? 'High CPU/GPU load detected — consider switching to 30 FPS.'
        : 'High CPU/GPU load detected.';
    setHighLoadSuggestion(advice);
  }, [handlePeerLeftDataChannel]);

  // Periodic system CPU/RAM + WebRTC FPS/RTT monitoring and high-load warnings.
  useEffect(() => {
    if (!normalizedHub || hasLeftRoom) return;
    void sampleSystemMetricsOnce();
    const timer = window.setInterval(() => {
      void sampleSystemMetricsOnce();
    }, METRICS_POLL_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [hasLeftRoom, normalizedHub, sampleSystemMetricsOnce]);

  return {
    hubId: normalizedHub || options.hubId,
    role: resolvedRole,
    hostInfo,
    isConnected,
    hasLeftRoom,
    knockStatus,
    knockError,
    entranceAccepted,
    pendingKnocks,
    peers,
    streams,
    localStream,
    isSharing,
    fps,
    isDeafened,
    layoutMode,
    spotlightStreamId,
    fullscreenStreamId,
    isMinimized,
    systemMetrics,
    highLoadSuggestion,
    connectionFailure,
    requestEntrance: sendKnockRequest,
    cancelKnock,
    acceptKnock: handleAcceptKnockAction,
    rejectKnock: handleRejectKnockAction,
    startSharing,
    stopSharing,
    toggleSharing,
    setFps,
    toggleFps,
    setStreamVolume,
    toggleDeafen,
    setLayoutMode,
    toggleLayoutMode,
    selectSpotlightStream,
    enterFullscreen,
    exitFullscreen,
    minimizeHub,
    restoreHub,
    leaveRoom,
    rejoinRoom,
    retryConnection,
    dismissConnectionFailure,
    dismissHighLoadSuggestion,
  };
};

export default useRoomSession;
