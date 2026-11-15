import {
  Dispatch,
  MutableRefObject,
  SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { signalingTransport, telemetryAdapter, webrtcStreamEngine } from '../adapters';
import { ROOM_CONFIG } from '../domain/config';
import {
  ConnectionFailureDto,
  DataChannelEnvelopeDto,
  DataChannelMessageType,
  DataChannelPayload,
  KnockDecisionPayload,
  PeerKickedPayload,
  PendingKnock,
  RoomPeerDto,
  SignalingEnvelopeDto,
  UserProfile,
} from '../domain/dtos';
import { canAcceptMorePeers } from '../domain/validators';
import { StreamEngineCallbacks } from '../ports';
import { getGuestInboxTopic, normalizeHubTopic } from '../utils/hubTopics';
import {
  DataChannelHandler,
  KEEPALIVE_POLL_MS,
  RemoteStreamMeta,
  RoomIdentityRefs,
  createSignalingEnvelope,
  createUniqueId,
  formatResolutionLabel,
  getMeshTokenForPair,
  toPeerCountTier,
} from './room/roomHelpers';

export interface MeshMediaBridge {
  isSharingRef: MutableRefObject<boolean>;
  fpsRef: MutableRefObject<ReturnType<typeof webrtcStreamEngine.getCurrentFps>>;
  resolutionRef: MutableRefObject<ReturnType<typeof webrtcStreamEngine.getCurrentResolution>>;
  remoteStreamsRef: MutableRefObject<Map<string, MediaStream>>;
  remoteMetaRef: MutableRefObject<Map<string, RemoteStreamMeta>>;
  rebuildStreams: () => void;
}

export interface UseMeshPeersOptions extends RoomIdentityRefs {
  normalizedHub: string;
  hasLeftRoom: boolean;
  waitingForProfile: boolean;
  profile: UserProfile;
  setConnectionFailure: Dispatch<SetStateAction<ConnectionFailureDto | null>>;
  media: MeshMediaBridge;
  onPongRtt: (measuredMs: number) => void;
  isEntranceAccepted: () => boolean;
  onHostLeftRoom: () => void;
  onConnectedToHost: () => void;
  onKickedFromRoom: (reason?: string) => void;
}

export interface UseMeshPeersResult {
  peers: RoomPeerDto[];
  peersRef: MutableRefObject<RoomPeerDto[]>;
  sessionTokenRef: MutableRefObject<string>;
  hostPeerIdRef: MutableRefObject<string>;
  peerTokensRef: MutableRefObject<Map<string, string>>;
  pendingPreAcceptSignalsRef: MutableRefObject<SignalingEnvelopeDto[]>;
  updatePeersList: (updater: (prev: RoomPeerDto[]) => RoomPeerDto[]) => RoomPeerDto[];
  setPeerStreamingFlag: (peerIdSafe: string, streaming: boolean) => void;
  broadcastRoomDataChannel: (payload: DataChannelPayload) => void;
  publishSignalToPeer: (remotePeerIdSafe: string, payload: SignalingEnvelopeDto['payload']) => Promise<void>;
  clearHostOfferTimer: () => void;
  processOfferEnvelope: (envelope: SignalingEnvelopeDto) => Promise<void> | void;
  processAnswerEnvelope: (envelope: SignalingEnvelopeDto) => Promise<void> | void;
  processIceEnvelope: (envelope: SignalingEnvelopeDto) => Promise<void> | void;
  processPeerKickedEnvelope: (envelope: SignalingEnvelopeDto) => void;
  admitGuestPeer: (knock: PendingKnock, replyTopic: string) => Promise<void>;
  kickPeer: (targetPeerIdSafe: string, reason?: string) => Promise<void>;
  onGuestEntranceAccepted: (payload: KnockDecisionPayload) => Promise<void>;
  handlePeerLeftDataChannel: (leftId: string) => void;
  configureStreamEngine: () => void;
  resetMeshPeersState: (forRejoin?: boolean) => void;
}

/**
 * Manages the P2P WebRTC mesh roster, signaling offer/answer/ICE dispatch,
 * DataChannel state messages, profile sync across peers, and the independent
 * keepalive ping/eviction loop.
 */
export const useMeshPeers = ({
  normalizedHub,
  hasLeftRoom,
  waitingForProfile,
  profile,
  mountedRef,
  profileRef,
  roleRef,
  hubRef,
  localPeerIdRef,
  setConnectionFailure,
  media,
  onPongRtt,
  isEntranceAccepted,
  onHostLeftRoom,
  onConnectedToHost,
  onKickedFromRoom,
}: UseMeshPeersOptions): UseMeshPeersResult => {
  const [peers, setPeers] = useState<RoomPeerDto[]>([]);

  const peersRef = useRef<RoomPeerDto[]>([]);
  const sessionTokenRef = useRef<string>('');
  const hostPeerIdRef = useRef<string>('');
  const peerTokensRef = useRef<Map<string, string>>(new Map());
  const pendingPreAcceptSignalsRef = useRef<SignalingEnvelopeDto[]>([]);
  const hostOfferTimerRef = useRef<number | null>(null);
  const kickedRef = useRef<boolean>(false);
  const mediaRef = useRef(media);
  mediaRef.current = media;
  const isEntranceAcceptedRef = useRef(isEntranceAccepted);
  isEntranceAcceptedRef.current = isEntranceAccepted;
  const onPongRttRef = useRef(onPongRtt);
  onPongRttRef.current = onPongRtt;
  const onHostLeftRoomRef = useRef(onHostLeftRoom);
  onHostLeftRoomRef.current = onHostLeftRoom;
  const onConnectedToHostRef = useRef(onConnectedToHost);
  onConnectedToHostRef.current = onConnectedToHost;
  const onKickedFromRoomRef = useRef(onKickedFromRoom);
  onKickedFromRoomRef.current = onKickedFromRoom;

  useEffect(() => {
    pendingPreAcceptSignalsRef.current = [];
    kickedRef.current = false;
  }, [normalizedHub]);

  const updatePeersList = useCallback(
    (updater: (prev: RoomPeerDto[]) => RoomPeerDto[]): RoomPeerDto[] => {
      const next = updater(peersRef.current);
      if (next === peersRef.current) return next;
      peersRef.current = next;
      if (mountedRef.current) setPeers(next);
      return next;
    },
    [mountedRef]
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

  const broadcastRoomDataChannel = useCallback((payload: DataChannelPayload): void => {
    const fallbackToken = sessionTokenRef.current || 'room-session';
    webrtcStreamEngine.broadcastDataChannelMessage(payload, fallbackToken);
  }, []);

  const publishSignalToPeer = useCallback(
    async (
      remotePeerIdSafe: string,
      payload: SignalingEnvelopeDto['payload']
    ): Promise<void> => {
      const targetHub = hubRef.current;
      if (!targetHub) return;
      const targetTopic = getGuestInboxTopic(targetHub, remotePeerIdSafe);
      if (!targetTopic) return;
      const envelope = createSignalingEnvelope(targetHub, localPeerIdRef.current, payload);
      await signalingTransport.publish(targetTopic, envelope);
    },
    [hubRef, localPeerIdRef]
  );

  const clearHostOfferTimer = useCallback((): void => {
    if (hostOfferTimerRef.current === null) return;
    window.clearTimeout(hostOfferTimerRef.current);
    hostOfferTimerRef.current = null;
  }, []);

  const cleanupExistingPeerConnection = useCallback(
    (peerIdSafe: string, removeFromRoster = false): boolean => {
      if (!peerIdSafe || peerIdSafe === localPeerIdRef.current) return false;
      const inRoster = peersRef.current.some((peer) => peer.peerIdSafe === peerIdSafe);
      const hasEnginePeer = webrtcStreamEngine.hasPeer(peerIdSafe);
      const hasStream = mediaRef.current.remoteStreamsRef.current.has(peerIdSafe);
      const hasMeta = mediaRef.current.remoteMetaRef.current.has(peerIdSafe);
      const hasToken = peerTokensRef.current.has(peerIdSafe);
      const hadConnection = inRoster || hasEnginePeer || hasStream || hasMeta || hasToken;

      webrtcStreamEngine.closePeer(peerIdSafe);
      mediaRef.current.remoteStreamsRef.current.delete(peerIdSafe);
      mediaRef.current.remoteMetaRef.current.delete(peerIdSafe);
      peerTokensRef.current.delete(peerIdSafe);

      if (removeFromRoster && inRoster) {
        updatePeersList((prev) => prev.filter((item) => item.peerIdSafe !== peerIdSafe));
        mediaRef.current.rebuildStreams();
      } else if (hasStream) {
        mediaRef.current.rebuildStreams();
      }

      return hadConnection;
    },
    [localPeerIdRef, updatePeersList]
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
    [cleanupExistingPeerConnection, hubRef, localPeerIdRef, roleRef]
  );

  const verifyAndRegisterOfferToken = useCallback(
    (fromPeerIdSafe: string, sessionToken: string): boolean => {
      if (!fromPeerIdSafe || !sessionToken || !hubRef.current) return false;

      if (roleRef.current === 'owner') {
        return peerTokensRef.current.get(fromPeerIdSafe) === sessionToken;
      }

      if (!isEntranceAcceptedRef.current()) return false;

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
    [hubRef, localPeerIdRef, roleRef]
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
      if (roleRef.current === 'guest' && !isEntranceAcceptedRef.current()) {
        bufferPreAcceptSignal(envelope);
        return;
      }
      const { fromPeerIdSafe, sdp, sessionToken } = envelope.payload;
      if (!verifyAndRegisterOfferToken(fromPeerIdSafe, sessionToken)) return;
      return webrtcStreamEngine.handleIncomingOffer(fromPeerIdSafe, sdp, sessionToken);
    },
    [bufferPreAcceptSignal, roleRef, verifyAndRegisterOfferToken]
  );

  const processAnswerEnvelope = useCallback(
    (envelope: SignalingEnvelopeDto): Promise<void> | void => {
      if (envelope.payload.type !== 'webrtc_answer') return;
      const { fromPeerIdSafe, sdp, sessionToken } = envelope.payload;
      if (peerTokensRef.current.get(fromPeerIdSafe) !== sessionToken) return;
      return webrtcStreamEngine.handleIncomingAnswer(fromPeerIdSafe, sdp, sessionToken);
    },
    []
  );

  const processIceEnvelope = useCallback(
    (envelope: SignalingEnvelopeDto): Promise<void> | void => {
      if (envelope.payload.type !== 'webrtc_ice') return;
      if (roleRef.current === 'guest' && !isEntranceAcceptedRef.current()) {
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
    [bufferPreAcceptSignal, roleRef, verifyAndRegisterOfferToken]
  );

  const admitGuestPeer = useCallback(
    async (knock: PendingKnock, replyTopic: string): Promise<void> => {
      if (roleRef.current !== 'owner' || !hubRef.current) return;

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
    [
      broadcastRoomDataChannel,
      cleanupExistingPeerConnection,
      hubRef,
      localPeerIdRef,
      profileRef,
      roleRef,
      updatePeersList,
    ]
  );

  const onGuestEntranceAccepted = useCallback(
    async (payload: KnockDecisionPayload): Promise<void> => {
      kickedRef.current = false;
      cleanupExistingPeerConnection(payload.hostPeerIdSafe, false);
      for (const peer of payload.peerRoster) {
        if (peer.peerIdSafe === payload.hostPeerIdSafe) continue;
        cleanupExistingPeerConnection(peer.peerIdSafe, false);
      }

      sessionTokenRef.current = payload.sessionToken;
      hostPeerIdRef.current = payload.hostPeerIdSafe;
      peerTokensRef.current.set(payload.hostPeerIdSafe, payload.sessionToken);
      webrtcStreamEngine.registerPeerSessionToken(payload.hostPeerIdSafe, payload.sessionToken);
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

      if (!webrtcStreamEngine.isPeerConnected(payload.hostPeerIdSafe)) {
        hostOfferTimerRef.current = window.setTimeout(() => {
          hostOfferTimerRef.current = null;
          if (!mountedRef.current || !isEntranceAcceptedRef.current()) return;
          if (webrtcStreamEngine.isPeerConnected(payload.hostPeerIdSafe)) return;

          const hasPeer = webrtcStreamEngine.hasPeer(payload.hostPeerIdSafe);
          setConnectionFailure({
            stage: hasPeer ? 'ice_negotiation' : 'sdp_handshake',
            reason: hasPeer
              ? 'Received host offer, but P2P DataChannel / ICE failed to establish within 8s.'
              : 'Accepted by host, but did not receive the WebRTC stream offer from host.',
            details: `host=${payload.hostPeerIdSafe}, hub=${hubRef.current}, hasPeer=${hasPeer}, connectedPeers=${webrtcStreamEngine.getConnectedPeerIds().join(',') || 'none'}`,
            peerIdSafe: payload.hostPeerIdSafe,
            timestamp: Date.now(),
          });
        }, 8000);
      }

      connectMeshPeersFromRoster(payload.peerRoster);
    },
    [
      cleanupExistingPeerConnection,
      connectMeshPeersFromRoster,
      hubRef,
      mountedRef,
      processIceEnvelope,
      processOfferEnvelope,
      setConnectionFailure,
      updatePeersList,
    ]
  );

  const handlePeerLeftDataChannel = useCallback(
    (leftId: string): void => {
      if (!leftId || leftId === localPeerIdRef.current) return;

      if (roleRef.current === 'guest' && leftId === hostPeerIdRef.current) {
        webrtcStreamEngine.closeAllPeers();
        mediaRef.current.remoteStreamsRef.current.clear();
        mediaRef.current.remoteMetaRef.current.clear();
        peerTokensRef.current.clear();
        sessionTokenRef.current = '';
        hostPeerIdRef.current = '';
        updatePeersList(() => []);
        mediaRef.current.rebuildStreams();
        onHostLeftRoomRef.current();
        return;
      }

      mediaRef.current.remoteStreamsRef.current.delete(leftId);
      mediaRef.current.remoteMetaRef.current.delete(leftId);
      peerTokensRef.current.delete(leftId);
      webrtcStreamEngine.closePeer(leftId);
      const nextRoster = updatePeersList((prev) =>
        prev.filter((item) => item.peerIdSafe !== leftId)
      );
      if (roleRef.current === 'owner') {
        broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
      }
      mediaRef.current.rebuildStreams();
    },
    [
      broadcastRoomDataChannel,
      localPeerIdRef,
      roleRef,
      updatePeersList,
    ]
  );

  const isSenderRoomHost = useCallback(
    (senderPeerIdSafe: string): boolean => {
      if (!senderPeerIdSafe || senderPeerIdSafe === localPeerIdRef.current) return false;
      if (hostPeerIdRef.current) {
        return senderPeerIdSafe === hostPeerIdRef.current;
      }
      const ownerPeer = peersRef.current.find((peer) => peer.role === 'owner');
      if (ownerPeer) {
        return senderPeerIdSafe === ownerPeer.peerIdSafe;
      }
      if (hubRef.current) {
        return (
          normalizeHubTopic(`elfy/hub/${senderPeerIdSafe}`).toLowerCase() ===
          hubRef.current.toLowerCase()
        );
      }
      return false;
    },
    [hubRef, localPeerIdRef]
  );

  const applyKickedFromRoom = useCallback(
    (reason?: string): void => {
      if (roleRef.current !== 'guest' || kickedRef.current) return;
      kickedRef.current = true;
      clearHostOfferTimer();
      webrtcStreamEngine.closeAllPeers();
      mediaRef.current.remoteStreamsRef.current.clear();
      mediaRef.current.remoteMetaRef.current.clear();
      peerTokensRef.current.clear();
      pendingPreAcceptSignalsRef.current = [];
      sessionTokenRef.current = '';
      hostPeerIdRef.current = '';
      updatePeersList(() => []);
      mediaRef.current.rebuildStreams();
      onKickedFromRoomRef.current(reason);
    },
    [clearHostOfferTimer, roleRef, updatePeersList]
  );

  const processPeerKickedEnvelope = useCallback(
    (envelope: SignalingEnvelopeDto): void => {
      if (envelope.payload.type !== 'peer_kicked') return;
      if (roleRef.current !== 'guest') return;
      if (
        hubRef.current &&
        normalizeHubTopic(envelope.hubId).toLowerCase() !== hubRef.current.toLowerCase()
      ) {
        return;
      }
      if (!isSenderRoomHost(envelope.senderPeerIdSafe)) return;
      if (envelope.payload.peerIdSafe !== localPeerIdRef.current) return;
      applyKickedFromRoom(envelope.payload.reason);
    },
    [applyKickedFromRoom, hubRef, isSenderRoomHost, localPeerIdRef, roleRef]
  );

  const kickPeer = useCallback(
    async (targetPeerIdSafe: string, reason?: string): Promise<void> => {
      if (roleRef.current !== 'owner') return;
      if (!targetPeerIdSafe || targetPeerIdSafe === localPeerIdRef.current) return;

      const trimmedReason = reason?.trim();
      const payload: PeerKickedPayload = {
        type: 'peer_kicked',
        peerIdSafe: targetPeerIdSafe,
        ...(trimmedReason ? { reason: trimmedReason } : {}),
      };

      const token =
        peerTokensRef.current.get(targetPeerIdSafe) || sessionTokenRef.current || 'room-session';
      webrtcStreamEngine.sendDataChannelMessage(targetPeerIdSafe, payload, token);

      const signalPublish = publishSignalToPeer(targetPeerIdSafe, payload).catch((err) => {
        console.warn('[useMeshPeers] Failed to publish peer_kicked signal:', err);
      });

      cleanupExistingPeerConnection(targetPeerIdSafe, true);
      broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: peersRef.current });

      await signalPublish;
    },
    [
      broadcastRoomDataChannel,
      cleanupExistingPeerConnection,
      localPeerIdRef,
      publishSignalToPeer,
      roleRef,
    ]
  );

  const evictStalePeerWithoutLeavingRoom = useCallback(
    (stalePeerId: string): void => {
      if (!stalePeerId || stalePeerId === localPeerIdRef.current) return;

      mediaRef.current.remoteStreamsRef.current.delete(stalePeerId);
      mediaRef.current.remoteMetaRef.current.delete(stalePeerId);
      peerTokensRef.current.delete(stalePeerId);
      webrtcStreamEngine.closePeer(stalePeerId);

      const nextRoster = updatePeersList((prev) =>
        prev.filter((item) => item.peerIdSafe !== stalePeerId)
      );
      if (roleRef.current === 'owner') {
        broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
      }
      mediaRef.current.rebuildStreams();

      if (roleRef.current === 'guest' && stalePeerId === hostPeerIdRef.current && mountedRef.current) {
        setConnectionFailure(
          (prev) =>
            prev ?? {
              stage: 'peer_disconnected',
              reason: 'Lost connection to the host stream session.',
              details: `host=${stalePeerId}, hub=${hubRef.current}`,
              peerIdSafe: stalePeerId,
              timestamp: Date.now(),
            }
        );
      }
    },
    [
      broadcastRoomDataChannel,
      hubRef,
      localPeerIdRef,
      mountedRef,
      roleRef,
      setConnectionFailure,
      updatePeersList,
    ]
  );

  const handleDataChannelOpenCallback = useCallback(
    (peerIdSafe: string): void => {
      const token =
        peerTokensRef.current.get(peerIdSafe) || sessionTokenRef.current || 'room-session';
      if (roleRef.current === 'guest' && peerIdSafe === hostPeerIdRef.current) {
        clearHostOfferTimer();
        onConnectedToHostRef.current();
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
      if (mediaRef.current.isSharingRef.current) {
        webrtcStreamEngine.sendDataChannelMessage(
          peerIdSafe,
          {
            type: 'stream_started',
            peerIdSafe: localPeerIdRef.current,
            displayName: profileRef.current.nickname,
            avatarUrl: profileRef.current.avatarUrl,
            resolution: formatResolutionLabel(mediaRef.current.resolutionRef.current),
            fps: mediaRef.current.fpsRef.current,
          },
          token
        );
        void webrtcStreamEngine.refreshSenderEncodingParams();
      }
      webrtcStreamEngine.sendDataChannelMessage(
        peerIdSafe,
        { type: 'ping', sentAt: Date.now() },
        token
      );
    },
    [
      clearHostOfferTimer,
      localPeerIdRef,
      mountedRef,
      profileRef,
      roleRef,
      setConnectionFailure,
    ]
  );

  const handlePeerStateChangeCallback = useCallback(
    (peerIdSafe: string, state: RTCPeerConnectionState): void => {
      if (state !== 'failed' && state !== 'closed') return;
      mediaRef.current.remoteStreamsRef.current.delete(peerIdSafe);
      if (roleRef.current === 'owner') {
        const nextRoster = updatePeersList((prev) =>
          prev.filter((item) => item.peerIdSafe !== peerIdSafe)
        );
        broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
      }
      mediaRef.current.rebuildStreams();
    },
    [broadcastRoomDataChannel, roleRef, updatePeersList]
  );

  const createDcDispatchMap = useCallback((): Record<DataChannelMessageType, DataChannelHandler> => {
    return {
      peer_roster_sync: (_peerId, env) => {
        if (env.payload.type !== 'peer_roster_sync') return;
        const roster = env.payload.peers;
        const incomingIds = new Set(roster.map((item) => item.peerIdSafe));
        const trackedIds = new Set<string>([
          ...peersRef.current.map((item) => item.peerIdSafe),
          ...webrtcStreamEngine.getConnectedPeerIds(),
          ...peerTokensRef.current.keys(),
          ...mediaRef.current.remoteStreamsRef.current.keys(),
          ...mediaRef.current.remoteMetaRef.current.keys(),
        ]);

        for (const trackedId of trackedIds) {
          if (trackedId === localPeerIdRef.current || trackedId === hostPeerIdRef.current) {
            continue;
          }
          if (!incomingIds.has(trackedId)) {
            cleanupExistingPeerConnection(trackedId, false);
          }
        }

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
        mediaRef.current.rebuildStreams();
      },
      stream_started: (_peerId, env) => {
        if (env.payload.type !== 'stream_started') return;
        const p = env.payload;
        mediaRef.current.remoteMetaRef.current.set(p.peerIdSafe, {
          resolution: p.resolution,
          fps: p.fps,
          displayName: p.displayName,
          avatarUrl: p.avatarUrl,
        });
        updatePeersList((prev) =>
          prev.map((peer) =>
            peer.peerIdSafe === p.peerIdSafe
              ? { ...peer, displayName: p.displayName, avatarUrl: p.avatarUrl, isStreaming: true }
              : peer
          )
        );
        mediaRef.current.rebuildStreams();
      },
      stream_stopped: (_peerId, env) => {
        if (env.payload.type !== 'stream_stopped') return;
        mediaRef.current.remoteMetaRef.current.delete(env.payload.peerIdSafe);
        mediaRef.current.remoteStreamsRef.current.delete(env.payload.peerIdSafe);
        setPeerStreamingFlag(env.payload.peerIdSafe, false);
        mediaRef.current.rebuildStreams();
      },
      peer_profile_updated: (_peerId, env) => {
        if (env.payload.type !== 'peer_profile_updated') return;
        const p = env.payload;
        const existingMeta = mediaRef.current.remoteMetaRef.current.get(p.peerIdSafe);
        if (existingMeta) {
          mediaRef.current.remoteMetaRef.current.set(p.peerIdSafe, {
            ...existingMeta,
            displayName: p.displayName,
            avatarUrl: p.avatarUrl,
          });
        }
        const nextRoster = updatePeersList((prev) =>
          prev.map((peer) =>
            peer.peerIdSafe === p.peerIdSafe
              ? { ...peer, displayName: p.displayName, avatarUrl: p.avatarUrl }
              : peer
          )
        );
        if (roleRef.current === 'owner') {
          broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
        }
        mediaRef.current.rebuildStreams();
      },
      renegotiate_offer: () => {},
      renegotiate_answer: () => {},
      renegotiate_ice: () => {},
      peer_left: (_peerId, env) => {
        if (env.payload.type !== 'peer_left') return;
        handlePeerLeftDataChannel(env.payload.peerIdSafe);
      },
      peer_kicked: (peerIdSafe, env) => {
        if (env.payload.type !== 'peer_kicked') return;
        if (roleRef.current !== 'guest') return;
        if (!isSenderRoomHost(peerIdSafe) || !isSenderRoomHost(env.senderPeerIdSafe)) return;
        if (env.payload.peerIdSafe !== localPeerIdRef.current) return;
        applyKickedFromRoom(env.payload.reason);
      },
      ping: () => {},
      pong: (_peerId, env) => {
        if (env.payload.type !== 'pong') return;
        onPongRttRef.current(Math.max(1, Date.now() - env.payload.echoSentAt));
      },
    };
  }, [
    applyKickedFromRoom,
    broadcastRoomDataChannel,
    cleanupExistingPeerConnection,
    connectMeshPeersFromRoster,
    handlePeerLeftDataChannel,
    isSenderRoomHost,
    localPeerIdRef,
    roleRef,
    setPeerStreamingFlag,
    updatePeersList,
  ]);

  const configureStreamEngine = useCallback((): void => {
    const dcHandlers = createDcDispatchMap();
    const callbacks: StreamEngineCallbacks = {
      onRemoteStream: (peerIdSafe, stream) => {
        if (webrtcStreamEngine.isPeerConnected(peerIdSafe)) {
          if (peerIdSafe === hostPeerIdRef.current) {
            clearHostOfferTimer();
          }
          if (mountedRef.current) {
            setConnectionFailure(null);
          }
        }
        mediaRef.current.remoteStreamsRef.current.set(peerIdSafe, stream);
        setPeerStreamingFlag(peerIdSafe, true);
        mediaRef.current.rebuildStreams();
      },
      onRemoteStreamRemoved: (peerIdSafe) => {
        mediaRef.current.remoteStreamsRef.current.delete(peerIdSafe);
        setPeerStreamingFlag(peerIdSafe, false);
        mediaRef.current.rebuildStreams();
      },
      onPeerConnectionStateChange: handlePeerStateChangeCallback,
      onPeerConnectionError: (failure) => {
        if (!mountedRef.current) return;
        setConnectionFailure(failure);
      },
      onDataChannelOpen: handleDataChannelOpenCallback,
      onDataChannelMessage: (peerIdSafe, envelope: DataChannelEnvelopeDto) => {
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
    clearHostOfferTimer,
    createDcDispatchMap,
    handleDataChannelOpenCallback,
    handlePeerStateChangeCallback,
    hubRef,
    localPeerIdRef,
    mountedRef,
    publishSignalToPeer,
    setConnectionFailure,
    setPeerStreamingFlag,
  ]);

  const resetMeshPeersState = useCallback((forRejoin = false): void => {
    if (forRejoin) {
      kickedRef.current = false;
    }
    clearHostOfferTimer();
    webrtcStreamEngine.closeAllPeers();
    peerTokensRef.current.clear();
    pendingPreAcceptSignalsRef.current = [];
    peersRef.current = [];
    sessionTokenRef.current = '';
    hostPeerIdRef.current = '';
    if (mountedRef.current) {
      setPeers([]);
    }
  }, [clearHostOfferTimer, mountedRef]);

  // Dedicated peer keepalive/cleanup loop decoupled from UI system metrics polling.
  useEffect(() => {
    if (!normalizedHub || hasLeftRoom) return;

    const runKeepaliveSweep = (): void => {
      if (kickedRef.current) return;
      const evictedPeers = webrtcStreamEngine.pingAndCleanupPeers();
      const now = Date.now();
      const orphanedPeers = peersRef.current
        .filter((peer) => {
          if (peer.peerIdSafe === localPeerIdRef.current) return false;
          if (roleRef.current === 'guest' && peer.peerIdSafe === hostPeerIdRef.current) {
            return false;
          }
          if (now - peer.joinedAt <= 12000) return false;
          return !webrtcStreamEngine.hasPeer(peer.peerIdSafe);
        })
        .map((peer) => peer.peerIdSafe);

      for (const stalePeerId of new Set([...evictedPeers, ...orphanedPeers])) {
        evictStalePeerWithoutLeavingRoom(stalePeerId);
      }
    };

    const timer = window.setInterval(runKeepaliveSweep, KEEPALIVE_POLL_MS);
    return () => {
      window.clearInterval(timer);
    };
  }, [evictStalePeerWithoutLeavingRoom, hasLeftRoom, localPeerIdRef, normalizedHub, roleRef]);

  // Sync live nickname/avatar edits to peers over DataChannel without reconnecting.
  useEffect(() => {
    if (waitingForProfile || hasLeftRoom || !hubRef.current) return;
    const myId = localPeerIdRef.current;
    if (!myId) return;

    let profileChanged = false;
    const nextRoster = updatePeersList((prev) => {
      const mapped = prev.map((peer) => {
        if (peer.peerIdSafe !== myId) return peer;
        if (peer.displayName === profile.nickname && peer.avatarUrl === profile.avatarUrl) {
          return peer;
        }
        profileChanged = true;
        return {
          ...peer,
          displayName: profile.nickname,
          avatarUrl: profile.avatarUrl,
        };
      });
      return profileChanged ? mapped : prev;
    });

    if (!profileChanged) return;

    mediaRef.current.rebuildStreams();

    if (roleRef.current === 'owner' || isEntranceAcceptedRef.current()) {
      broadcastRoomDataChannel({
        type: 'peer_profile_updated',
        peerIdSafe: myId,
        displayName: profile.nickname,
        avatarUrl: profile.avatarUrl,
      });

      if (mediaRef.current.isSharingRef.current) {
        broadcastRoomDataChannel({
          type: 'stream_started',
          peerIdSafe: myId,
          displayName: profile.nickname,
          avatarUrl: profile.avatarUrl,
          resolution: formatResolutionLabel(mediaRef.current.resolutionRef.current),
          fps: mediaRef.current.fpsRef.current,
        });
      }

      if (roleRef.current === 'owner') {
        broadcastRoomDataChannel({ type: 'peer_roster_sync', peers: nextRoster });
      }
    }
  }, [
    broadcastRoomDataChannel,
    hasLeftRoom,
    hubRef,
    localPeerIdRef,
    normalizedHub,
    profile.avatarUrl,
    profile.nickname,
    roleRef,
    updatePeersList,
    waitingForProfile,
  ]);

  return {
    peers,
    peersRef,
    sessionTokenRef,
    hostPeerIdRef,
    peerTokensRef,
    pendingPreAcceptSignalsRef,
    updatePeersList,
    setPeerStreamingFlag,
    broadcastRoomDataChannel,
    publishSignalToPeer,
    clearHostOfferTimer,
    processOfferEnvelope,
    processAnswerEnvelope,
    processIceEnvelope,
    processPeerKickedEnvelope,
    admitGuestPeer,
    kickPeer,
    onGuestEntranceAccepted,
    handlePeerLeftDataChannel,
    configureStreamEngine,
    resetMeshPeersState,
  };
};
