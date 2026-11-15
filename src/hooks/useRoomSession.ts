import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  localWindowBus,
  signalingTransport,
  telemetryAdapter,
  webrtcStreamEngine,
} from '../adapters';
import {
  ConnectionFailureDto,
  DataChannelPayload,
  HubStatusResponsePayload,
  KnockStatus,
  LocalWindowBusMessage,
  LocalWindowBusMessageType,
  PeerTelemetryHistoryPointDto,
  PendingKnock,
  RoomPeerDto,
  RoomRole,
  SignalingEnvelopeDto,
  SignalingMessageType,
  StreamFpsOption,
  StreamItem,
  StreamResolutionPreset,
  SystemMetricsDto,
  TelemetryHistoryPointDto,
  UserProfile,
  WatchLayoutMode,
} from '../domain/dtos';
import { STREAM_CONFIG } from '../domain/config';
import {
  extractHostFromHub,
  getGuestInboxTopic,
  getKnockTopic,
  getProbeTopic,
  isHubOwner,
  normalizeHubTopic,
  toSafePeerTag,
} from '../utils/hubTopics';
import {
  BusHandler,
  SignalingHandler,
  createSelfPeer,
  createSignalingEnvelope,
  isWaitingForDefaultProfile,
} from './room/roomHelpers';
import { useKnockGate } from './useKnockGate';
import { useMediaSharing } from './useMediaSharing';
import { useMeshPeers } from './useMeshPeers';
import { useRoomMetrics } from './useRoomMetrics';

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
  localPeerIdSafe: string;
  hostInfo: { displayName: string; tag: string };
  isConnected: boolean;
  hasLeftRoom: boolean;
  kickedReason: string | null;
  knockStatus: KnockStatus;
  knockError: string | null;
  entranceAccepted: boolean;
  pendingKnocks: PendingKnock[];
  peers: RoomPeerDto[];
  streams: StreamItem[];
  localStream: MediaStream | null;
  isSharing: boolean;
  isLocalPreviewEnabled: boolean;
  fps: StreamFpsOption;
  resolution: StreamResolutionPreset;
  isDeafened: boolean;
  streamVolumes: Record<string, number>;
  layoutMode: WatchLayoutMode;
  spotlightStreamId: string | null;
  fullscreenStreamId: string | null;
  isMinimized: boolean;
  systemMetrics: SystemMetricsDto;
  telemetryHistory: TelemetryHistoryPointDto[];
  peerTelemetryHistory: Record<string, PeerTelemetryHistoryPointDto[]>;
  highLoadSuggestion: string | null;
  connectionFailure: ConnectionFailureDto | null;
  requestEntrance: () => Promise<void>;
  cancelKnock: () => void;
  acceptKnock: (knock: PendingKnock) => Promise<void>;
  rejectKnock: (knock: PendingKnock) => Promise<void>;
  kickPeer: (targetPeerIdSafe: string, reason?: string) => Promise<void>;
  clearKickedState: () => void;
  startSharing: () => Promise<void>;
  stopSharing: () => Promise<void>;
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
  leaveRoom: () => Promise<void>;
  rejoinRoom: () => void;
  retryConnection: () => void;
  dismissConnectionFailure: () => void;
  dismissHighLoadSuggestion: () => void;
}

/**
 * Orchestrates a room session by composing media sharing, WebRTC mesh peers,
 * knock admission/toast gating, system metrics polling, and MQTT lifecycle.
 */
export const useRoomSession = (options: UseRoomSessionOptions): UseRoomSessionResult => {
  const normalizedHub = normalizeHubTopic(options.hubId);
  const resolvedRole: RoomRole =
    options.role ?? (isHubOwner(options.hubId, options.profile) ? 'owner' : 'guest');
  const localPeerIdSafe = toSafePeerTag(options.profile.nickname, options.profile.peerTag);
  const hostInfo = extractHostFromHub(normalizedHub || options.hubId);
  const waitingForProfile = isWaitingForDefaultProfile(
    options.profile,
    options.isProfileLoading
  );

  const [isConnected, setIsConnected] = useState<boolean>(signalingTransport.isConnected);
  const [hasLeftRoom, setHasLeftRoom] = useState<boolean>(false);
  const [kickedReason, setKickedReason] = useState<string | null>(null);
  const [isRoomReady, setIsRoomReady] = useState<boolean>(false);
  const [sessionNonce, setSessionNonce] = useState<number>(0);
  const [connectionFailure, setConnectionFailure] = useState<ConnectionFailureDto | null>(null);

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

  const hasAutoStartedRef = useRef<boolean>(false);
  const roomUnsubsRef = useRef<Array<() => void>>([]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setHasLeftRoom(false);
    setKickedReason(null);
    setIsRoomReady(false);
    hasAutoStartedRef.current = false;
  }, [normalizedHub]);

  // Ref bridges allow focused child hooks to collaborate without circular render deps.
  const meshBridgeRef = useRef<{
    getPeersSnapshot: () => RoomPeerDto[];
    getHostPeerId: () => string;
    setPeerStreamingFlag: (peerIdSafe: string, streaming: boolean) => void;
    broadcastRoomDataChannel: (payload: DataChannelPayload) => void;
  }>({
    getPeersSnapshot: () => [],
    getHostPeerId: () => '',
    setPeerStreamingFlag: () => {},
    broadcastRoomDataChannel: () => {},
  });

  const knockBridgeRef = useRef<{
    isEntranceAccepted: () => boolean;
    onHostLeftRoom: () => void;
    detachTransientKnockSub: () => void;
  }>({
    isEntranceAccepted: () => resolvedRole === 'owner',
    onHostLeftRoom: () => {},
    detachTransientKnockSub: () => {},
  });

  const kickedBridgeRef = useRef<(reason?: string) => void>(() => {});

  const handleCaptureError = useCallback((failure: ConnectionFailureDto | null): void => {
    if (failure === null) {
      setConnectionFailure((prev) => (prev?.stage === 'screen_capture' ? null : prev));
      return;
    }
    setConnectionFailure(failure);
  }, []);

  const bridgeGetPeersSnapshot = useCallback(
    () => meshBridgeRef.current.getPeersSnapshot(),
    []
  );
  const bridgeGetHostPeerId = useCallback(
    () => meshBridgeRef.current.getHostPeerId(),
    []
  );
  const bridgeSetPeerStreamingFlag = useCallback(
    (peerIdSafe: string, streaming: boolean) =>
      meshBridgeRef.current.setPeerStreamingFlag(peerIdSafe, streaming),
    []
  );
  const bridgeBroadcastRoomDataChannel = useCallback(
    (payload: DataChannelPayload) => meshBridgeRef.current.broadcastRoomDataChannel(payload),
    []
  );
  const bridgeIsEntranceAccepted = useCallback(
    () => knockBridgeRef.current.isEntranceAccepted(),
    []
  );
  const bridgeOnHostLeftRoom = useCallback(
    () => knockBridgeRef.current.onHostLeftRoom(),
    []
  );
  const bridgeDetachTransientKnockSub = useCallback(
    () => knockBridgeRef.current.detachTransientKnockSub(),
    []
  );
  const bridgeOnKickedFromRoom = useCallback(
    (reason?: string) => kickedBridgeRef.current(reason),
    []
  );

  const media = useMediaSharing({
    normalizedHub,
    initialFps: options.profile.preferredFps ?? STREAM_CONFIG.DEFAULT_FPS,
    mountedRef,
    profileRef,
    roleRef,
    hubRef,
    localPeerIdRef,
    hostInfoRef,
    getPeersSnapshot: bridgeGetPeersSnapshot,
    getHostPeerId: bridgeGetHostPeerId,
    onPeerStreamingChanged: bridgeSetPeerStreamingFlag,
    onBroadcastDataChannel: bridgeBroadcastRoomDataChannel,
    onCaptureError: handleCaptureError,
  });

  const metrics = useRoomMetrics({
    normalizedHub,
    hasLeftRoom: hasLeftRoom || Boolean(kickedReason),
    mountedRef,
    roleRef,
    fpsRef: media.fpsRef,
    resolutionRef: media.resolutionRef,
  });

  const meshMediaBridge = useMemo(
    () => ({
      isSharingRef: media.isSharingRef,
      fpsRef: media.fpsRef,
      resolutionRef: media.resolutionRef,
      remoteStreamsRef: media.remoteStreamsRef,
      remoteMetaRef: media.remoteMetaRef,
      rebuildStreams: media.rebuildStreams,
    }),
    [
      media.fpsRef,
      media.isSharingRef,
      media.rebuildStreams,
      media.remoteMetaRef,
      media.remoteStreamsRef,
      media.resolutionRef,
    ]
  );

  const mesh = useMeshPeers({
    normalizedHub,
    hasLeftRoom,
    waitingForProfile,
    profile: options.profile,
    mountedRef,
    profileRef,
    roleRef,
    hubRef,
    localPeerIdRef,
    hostInfoRef,
    setConnectionFailure,
    media: meshMediaBridge,
    onPongRtt: metrics.recordPongRtt,
    isEntranceAccepted: bridgeIsEntranceAccepted,
    onHostLeftRoom: bridgeOnHostLeftRoom,
    onConnectedToHost: bridgeDetachTransientKnockSub,
    onKickedFromRoom: bridgeOnKickedFromRoom,
  });

  meshBridgeRef.current = {
    getPeersSnapshot: () => mesh.peersRef.current,
    getHostPeerId: () => mesh.hostPeerIdRef.current,
    setPeerStreamingFlag: mesh.setPeerStreamingFlag,
    broadcastRoomDataChannel: mesh.broadcastRoomDataChannel,
  };

  const knockGate = useKnockGate({
    normalizedHub,
    resolvedRole,
    hasLeftRoom,
    waitingForProfile,
    isRoomReady,
    mountedRef,
    profileRef,
    roleRef,
    hubRef,
    localPeerIdRef,
    hostInfoRef,
    getPeersSnapshot: bridgeGetPeersSnapshot,
    admitGuestPeer: mesh.admitGuestPeer,
    onGuestEntranceAccepted: mesh.onGuestEntranceAccepted,
    onClearHostOfferTimer: mesh.clearHostOfferTimer,
    onRestoreHub: media.restoreHub,
  });

  knockBridgeRef.current = {
    isEntranceAccepted: () => knockGate.entranceAcceptedRef.current,
    onHostLeftRoom: knockGate.onHostLeftRoom,
    detachTransientKnockSub: knockGate.detachTransientKnockSub,
  };

  const cleanupTransportSubscriptions = useCallback((): void => {
    knockGate.clearKnockGateTimers();
    mesh.clearHostOfferTimer();
    for (const unsub of roomUnsubsRef.current) {
      unsub();
    }
    roomUnsubsRef.current = [];
  }, [knockGate, mesh]);

  const resetRoomSessionState = useCallback(
    (forRejoin = false): void => {
      cleanupTransportSubscriptions();
      media.resetMediaState();
      mesh.resetMeshPeersState(forRejoin);
      knockGate.resetKnockGateState(forRejoin);
      hasAutoStartedRef.current = false;
      if (mountedRef.current) {
        setConnectionFailure(null);
      }
    },
    [cleanupTransportSubscriptions, knockGate, media, mesh]
  );

  kickedBridgeRef.current = (reason?: string): void => {
    const resolvedReason = reason?.trim() || 'You were removed from the room by the host.';
    resetRoomSessionState(false);
    if (mountedRef.current) {
      setIsRoomReady(false);
      setKickedReason(resolvedReason);
    }
    if (hubRef.current) {
      void localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
    }
  };

  const clearKickedState = useCallback((): void => {
    setKickedReason(null);
  }, []);

  const leaveRoom = useCallback(async (): Promise<void> => {
    const notifyTargets = new Set<string>();
    for (const peer of mesh.peersRef.current) {
      if (peer.peerIdSafe && peer.peerIdSafe !== localPeerIdRef.current) {
        notifyTargets.add(peer.peerIdSafe);
      }
    }
    if (mesh.hostPeerIdRef.current && mesh.hostPeerIdRef.current !== localPeerIdRef.current) {
      notifyTargets.add(mesh.hostPeerIdRef.current);
    }

    mesh.broadcastRoomDataChannel({ type: 'peer_left', peerIdSafe: localPeerIdRef.current });
    const peerLeftPublishes = Array.from(notifyTargets).map((peerId) =>
      mesh.publishSignalToPeer(peerId, {
        type: 'peer_left',
        peerIdSafe: localPeerIdRef.current,
      })
    );
    if (peerLeftPublishes.length > 0) {
      await Promise.race([
        Promise.allSettled(peerLeftPublishes),
        new Promise<void>((resolve) => window.setTimeout(resolve, 400)),
      ]);
    }

    try {
      await media.stopSharing({ skipRenegotiate: true });
    } finally {
      resetRoomSessionState(false);

      if (mountedRef.current) {
        setKickedReason(null);
        setIsRoomReady(false);
        setHasLeftRoom(true);
      }

      if (hubRef.current) {
        await localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
      }
    }
  }, [media, mesh, resetRoomSessionState]);

  const rejoinRoom = useCallback((): void => {
    resetRoomSessionState(true);
    setKickedReason(null);
    setIsRoomReady(false);
    setHasLeftRoom(false);
    setSessionNonce((n) => n + 1);
  }, [resetRoomSessionState]);

  const dismissConnectionFailure = useCallback((): void => {
    setConnectionFailure(null);
  }, []);

  const retryConnection = useCallback((): void => {
    setConnectionFailure(null);
    rejoinRoom();
  }, [rejoinRoom]);

  const handleProbeRequest = useCallback(
    async (envelope: SignalingEnvelopeDto): Promise<void> => {
      if (roleRef.current !== 'owner' || !hubRef.current) return;
      if (envelope.payload.type !== 'hub_status_request') return;

      const streamingPeers = mesh.peersRef.current.filter((peer) => peer.isStreaming);
      const streamerNames = streamingPeers.map((peer) => peer.displayName);
      const isBroadcasting = streamerNames.length > 0 || media.isSharingRef.current;
      if (media.isSharingRef.current && !streamerNames.includes(profileRef.current.nickname)) {
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
          peers: mesh.peersRef.current.length,
          streamerNames,
          respondedAt: Date.now(),
        }
      );

      await signalingTransport.publish(replyTopic, response);
    },
    [media.isSharingRef, mesh.peersRef]
  );

  const createSignalingDispatchMap = useCallback((): Record<
    SignalingMessageType,
    SignalingHandler
  > => {
    return {
      hub_status_request: (env) => handleProbeRequest(env),
      hub_status_response: () => {},
      knock_request: (env) => knockGate.handleIncomingKnockRequest(env),
      knock_decision: (env) => knockGate.handleKnockDecision(env),
      webrtc_offer: (env) => mesh.processOfferEnvelope(env),
      webrtc_answer: (env) => mesh.processAnswerEnvelope(env),
      webrtc_ice: (env) => mesh.processIceEnvelope(env),
      peer_left: (env) => {
        if (env.payload.type !== 'peer_left') return;
        mesh.handlePeerLeftDataChannel(env.payload.peerIdSafe);
      },
      peer_kicked: (env) => mesh.processPeerKickedEnvelope(env),
    };
  }, [handleProbeRequest, knockGate, mesh]);

  // Main stable room lifecycle effect — keyed strictly on primitive identity & hub values.
  useEffect(() => {
    if (!normalizedHub || waitingForProfile || hasLeftRoom) return;

    let cancelled = false;
    setIsRoomReady(false);
    mesh.configureStreamEngine();
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
        knockGate.markGuestKnocking();
        await knockGate.sendKnockRequest();
        if (!cancelled) setIsRoomReady(true);
        return;
      }

      knockGate.markOwnerAccepted();
      mesh.updatePeersList(() => [
        createSelfPeer(profileRef.current, localPeerIdSafe, 'owner', media.isSharingRef.current),
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
      setIsRoomReady(true);

      void telemetryAdapter.trackEvent('room_joined', { role: 'owner', peerCountTier: '1' });
      if (options.autoStart && !hasAutoStartedRef.current) {
        hasAutoStartedRef.current = true;
        void media.startSharing();
      }
    };

    void initializeSession();

    const handleBeforeUnload = (): void => {
      mesh.broadcastRoomDataChannel({ type: 'peer_left', peerIdSafe: localPeerIdRef.current });
      if (hubRef.current) {
        void localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: hubRef.current });
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      cancelled = true;
      setIsRoomReady(false);
      window.removeEventListener('beforeunload', handleBeforeUnload);
      cleanupTransportSubscriptions();
      webrtcStreamEngine.closeAllPeers();
      media.resetMediaState();
    };
    // Dependencies deliberately exclude mutable hook objects; lifecycle keys strictly on identity & session state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    hasLeftRoom,
    localPeerIdSafe,
    normalizedHub,
    options.autoStart,
    resolvedRole,
    sessionNonce,
    waitingForProfile,
  ]);

  const leaveRoomRef = useRef(leaveRoom);
  leaveRoomRef.current = leaveRoom;
  const restoreHubRef = useRef(media.restoreHub);
  restoreHubRef.current = media.restoreHub;

  // Listen on localWindowBus for restore / disconnect commands targeting this hub.
  useEffect(() => {
    const busHandlers: Record<LocalWindowBusMessageType, BusHandler> = {
      profile_updated: () => {},
      minimized_hub_updated: () => {},
      minimized_hub_cleared: () => {},
      owner_room_status: () => {},
      restore_hub_requested: (msg: LocalWindowBusMessage) => {
        if (msg.type !== 'restore_hub_requested') return;
        if (normalizeHubTopic(msg.hubId) !== hubRef.current) return;
        void restoreHubRef.current();
      },
      disconnect_hub_requested: (msg: LocalWindowBusMessage) => {
        if (msg.type !== 'disconnect_hub_requested') return;
        if (normalizeHubTopic(msg.hubId) !== hubRef.current) return;
        void leaveRoomRef.current();
      },
    };

    return localWindowBus.subscribe((message) => {
      busHandlers[message.type](message);
    });
  }, []);

  return {
    hubId: normalizedHub || options.hubId,
    role: resolvedRole,
    localPeerIdSafe,
    hostInfo,
    isConnected,
    hasLeftRoom,
    kickedReason,
    knockStatus: knockGate.knockStatus,
    knockError: knockGate.knockError,
    entranceAccepted: knockGate.entranceAccepted,
    pendingKnocks: knockGate.pendingKnocks,
    peers: mesh.peers,
    streams: media.streams,
    localStream: media.localStream,
    isSharing: media.isSharing,
    isLocalPreviewEnabled: media.isLocalPreviewEnabled,
    fps: media.fps,
    resolution: media.resolution,
    isDeafened: media.isDeafened,
    streamVolumes: media.streamVolumes,
    layoutMode: media.layoutMode,
    spotlightStreamId: media.spotlightStreamId,
    fullscreenStreamId: media.fullscreenStreamId,
    isMinimized: media.isMinimized,
    systemMetrics: metrics.systemMetrics,
    telemetryHistory: metrics.telemetryHistory,
    peerTelemetryHistory: metrics.peerTelemetryHistory,
    highLoadSuggestion: metrics.highLoadSuggestion,
    connectionFailure,
    requestEntrance: knockGate.sendKnockRequest,
    cancelKnock: knockGate.cancelKnock,
    acceptKnock: knockGate.acceptKnock,
    rejectKnock: knockGate.rejectKnock,
    kickPeer: mesh.kickPeer,
    clearKickedState,
    startSharing: media.startSharing,
    stopSharing: () => media.stopSharing(),
    toggleSharing: media.toggleSharing,
    toggleLocalPreview: media.toggleLocalPreview,
    setLocalPreviewEnabled: media.setLocalPreviewEnabled,
    setFps: media.setFps,
    toggleFps: media.toggleFps,
    setResolution: media.setResolution,
    cycleResolution: media.cycleResolution,
    setStreamVolume: media.setStreamVolume,
    toggleDeafen: media.toggleDeafen,
    setLayoutMode: media.setLayoutMode,
    toggleLayoutMode: media.toggleLayoutMode,
    selectSpotlightStream: media.selectSpotlightStream,
    enterFullscreen: media.enterFullscreen,
    exitFullscreen: media.exitFullscreen,
    minimizeHub: media.minimizeHub,
    restoreHub: media.restoreHub,
    leaveRoom,
    rejoinRoom,
    retryConnection,
    dismissConnectionFailure,
    dismissHighLoadSuggestion: metrics.dismissHighLoadSuggestion,
  };
};

export default useRoomSession;
