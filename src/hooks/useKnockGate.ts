import { MutableRefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  localWindowBus,
  signalingTransport,
  storageRepository,
  telemetryAdapter,
} from '../adapters';
import { ROOM_CONFIG } from '../domain/config';
import {
  KnockDecisionPayload,
  KnockRequestPayload,
  KnockStatus,
  PendingKnock,
  RoomPeerDto,
  RoomRole,
  SignalingEnvelopeDto,
} from '../domain/dtos';
import { canAcceptMorePeers } from '../domain/validators';
import {
  extractHostFromHub,
  formatFullPeerTag,
  getGuestInboxTopic,
  getKnockTopic,
  normalizeHubTopic,
} from '../utils/hubTopics';
import { playKnockSound, showKnockNotification } from '../utils/notifications';
import {
  KnockToastActionPayload,
  claimToastActionTauri,
  consumePendingToastActionsTauri,
  listenKnockToastActionTauri,
  registerOwnerRoomSessionTauri,
  unregisterOwnerRoomSessionTauri,
} from '../utils/tauri';
import {
  KNOCK_TIMEOUT_MS,
  RoomIdentityRefs,
  createSignalingEnvelope,
  toPeerCountTier,
} from './room/roomHelpers';

export interface UseKnockGateOptions extends RoomIdentityRefs {
  normalizedHub: string;
  resolvedRole: RoomRole;
  hasLeftRoom: boolean;
  waitingForProfile: boolean;
  isRoomReady: boolean;
  getPeersSnapshot: () => RoomPeerDto[];
  admitGuestPeer: (knock: PendingKnock, replyTopic: string) => Promise<void>;
  onGuestEntranceAccepted: (payload: KnockDecisionPayload) => Promise<void>;
  onClearHostOfferTimer: () => void;
  onRestoreHub: () => Promise<void>;
}

export interface UseKnockGateResult {
  knockStatus: KnockStatus;
  knockError: string | null;
  entranceAccepted: boolean;
  pendingKnocks: PendingKnock[];
  entranceAcceptedRef: MutableRefObject<boolean>;
  sendKnockRequest: () => Promise<void>;
  cancelKnock: () => void;
  acceptKnock: (knock: PendingKnock) => Promise<void>;
  rejectKnock: (knock: PendingKnock) => Promise<void>;
  handleIncomingKnockRequest: (envelope: SignalingEnvelopeDto) => Promise<void>;
  handleKnockDecision: (envelope: SignalingEnvelopeDto) => Promise<void>;
  detachTransientKnockSub: () => void;
  clearKnockGateTimers: () => void;
  markOwnerAccepted: () => void;
  markGuestKnocking: () => void;
  onHostLeftRoom: () => void;
  resetKnockGateState: (forRejoin?: boolean) => void;
}

const persistJoinedFriendHub = async (
  hubTopic: string,
  payload: KnockDecisionPayload
): Promise<void> => {
  try {
    const existingHubs = await storageRepository.listFriendHubs();
    const existing = existingHubs.find((item) => normalizeHubTopic(item.hubId) === hubTopic);
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
    console.warn('[useKnockGate] Failed to save Friend Hub:', err);
  }
};

/**
 * Manages room entry knocking, owner admission/denial, knock timeouts,
 * owner room session registration, and Rust-coordinated Windows Toast actions.
 */
export const useKnockGate = ({
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
  getPeersSnapshot,
  admitGuestPeer,
  onGuestEntranceAccepted,
  onClearHostOfferTimer,
  onRestoreHub,
}: UseKnockGateOptions): UseKnockGateResult => {
  const [knockStatus, setKnockStatus] = useState<KnockStatus>(
    resolvedRole === 'owner' ? 'accepted' : 'knocking'
  );
  const [knockError, setKnockError] = useState<string | null>(null);
  const [entranceAccepted, setEntranceAccepted] = useState<boolean>(resolvedRole === 'owner');
  const [pendingKnocks, setPendingKnocks] = useState<PendingKnock[]>([]);

  const entranceAcceptedRef = useRef<boolean>(resolvedRole === 'owner');
  const pendingKnocksRef = useRef<PendingKnock[]>([]);
  pendingKnocksRef.current = pendingKnocks;
  const knockReplyTopicsRef = useRef<Map<string, string>>(new Map());
  const knockTimerRef = useRef<number | null>(null);
  const transientKnockUnsubRef = useRef<(() => void) | null>(null);
  const deferredToastActionsRef = useRef<KnockToastActionPayload[]>([]);
  const isRoomReadyRef = useRef<boolean>(isRoomReady);
  isRoomReadyRef.current = isRoomReady;

  const clearKnockTimer = useCallback((): void => {
    if (knockTimerRef.current === null) return;
    window.clearTimeout(knockTimerRef.current);
    knockTimerRef.current = null;
  }, []);

  const detachTransientKnockSub = useCallback((): void => {
    if (!transientKnockUnsubRef.current) return;
    transientKnockUnsubRef.current();
    transientKnockUnsubRef.current = null;
  }, []);

  const clearKnockGateTimers = useCallback((): void => {
    clearKnockTimer();
    detachTransientKnockSub();
  }, [clearKnockTimer, detachTransientKnockSub]);

  const markOwnerAccepted = useCallback((): void => {
    entranceAcceptedRef.current = true;
    setEntranceAccepted(true);
    setKnockStatus('accepted');
  }, []);

  const markGuestKnocking = useCallback((): void => {
    entranceAcceptedRef.current = false;
    setEntranceAccepted(false);
  }, []);

  const onHostLeftRoom = useCallback((): void => {
    entranceAcceptedRef.current = false;
    if (!mountedRef.current) return;
    setEntranceAccepted(false);
    setKnockStatus('idle');
    setKnockError('Host left the room. Knock again when they return.');
  }, [mountedRef]);

  const resetKnockGateState = useCallback(
    (forRejoin = false): void => {
      clearKnockGateTimers();
      knockReplyTopicsRef.current.clear();
      if (mountedRef.current) {
        setPendingKnocks([]);
        if (forRejoin) {
          const isOwner = roleRef.current === 'owner';
          entranceAcceptedRef.current = isOwner;
          setKnockError(null);
          setKnockStatus(isOwner ? 'accepted' : 'knocking');
          setEntranceAccepted(isOwner);
        }
      }
    },
    [clearKnockGateTimers, mountedRef, roleRef]
  );

  const acceptKnock = useCallback(
    async (knock: PendingKnock): Promise<void> => {
      if (roleRef.current !== 'owner' || !hubRef.current) return;
      setPendingKnocks((prev) => prev.filter((item) => item.peerIdSafe !== knock.peerIdSafe));

      const replyTopic =
        knockReplyTopicsRef.current.get(knock.peerIdSafe) ||
        getGuestInboxTopic(hubRef.current, knock.peerIdSafe);
      await admitGuestPeer(knock, replyTopic);
    },
    [admitGuestPeer, hubRef, roleRef]
  );

  const rejectKnock = useCallback(
    async (knock: PendingKnock): Promise<void> => {
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
    },
    [hubRef, localPeerIdRef, profileRef, roleRef]
  );

  const handleKnockDecision = useCallback(
    async (envelope: SignalingEnvelopeDto): Promise<void> => {
      if (roleRef.current !== 'guest' || envelope.payload.type !== 'knock_decision') return;
      const payload = envelope.payload;
      clearKnockTimer();
      onClearHostOfferTimer();

      if (!payload.accepted) {
        entranceAcceptedRef.current = false;
        setEntranceAccepted(false);
        setKnockStatus('rejected');
        setKnockError(payload.reason || 'Host declined your entrance request.');
        return;
      }

      entranceAcceptedRef.current = true;
      setEntranceAccepted(true);
      setKnockStatus('accepted');
      setKnockError(null);

      await onGuestEntranceAccepted(payload);

      if (hubRef.current) {
        await persistJoinedFriendHub(hubRef.current, payload);
      }

      void telemetryAdapter.trackEvent('room_joined', {
        role: 'guest',
        peerCountTier: toPeerCountTier(payload.peerRoster.length),
      });
    },
    [clearKnockTimer, hubRef, onClearHostOfferTimer, onGuestEntranceAccepted, roleRef]
  );

  const handleIncomingKnockRequest = useCallback(
    async (envelope: SignalingEnvelopeDto): Promise<void> => {
      if (roleRef.current !== 'owner' || !hubRef.current) return;
      if (envelope.payload.type !== 'knock_request') return;

      const payload = envelope.payload;
      if (payload.peerIdSafe === localPeerIdRef.current) return;

      const effectivePeerCount = getPeersSnapshot().filter(
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

      playKnockSound(payload.peerIdSafe, envelope.messageId);
      showKnockNotification(payload.displayName, payload.peerTag, {
        peerIdSafe: payload.peerIdSafe,
        hubId: hubRef.current,
        replyTopic: payload.replyTopic,
        messageId: envelope.messageId,
      });

      setPendingKnocks((prev) => [
        knockItem,
        ...prev.filter((item) => item.peerIdSafe !== payload.peerIdSafe),
      ]);
    },
    [getPeersSnapshot, hubRef, localPeerIdRef, profileRef, roleRef]
  );

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
  }, [
    clearKnockTimer,
    detachTransientKnockSub,
    handleKnockDecision,
    hubRef,
    localPeerIdRef,
    mountedRef,
    profileRef,
    roleRef,
  ]);

  const cancelKnock = useCallback((): void => {
    clearKnockTimer();
    detachTransientKnockSub();
    setKnockStatus('idle');
  }, [clearKnockTimer, detachTransientKnockSub]);

  const executeToastAction = useCallback(
    (payload: KnockToastActionPayload): void => {
      if (roleRef.current !== 'owner' || !hubRef.current) return;
      if (payload.hubId && normalizeHubTopic(payload.hubId) !== hubRef.current) return;

      if (payload.action === 'open') {
        void onRestoreHub();
        return;
      }

      if (!payload.peerIdSafe) return;
      if (payload.replyTopic) {
        knockReplyTopicsRef.current.set(payload.peerIdSafe, payload.replyTopic);
      }

      const existingKnock = pendingKnocksRef.current.find(
        (item) => item.peerIdSafe === payload.peerIdSafe
      );
      const knockTarget: PendingKnock = existingKnock ?? {
        id: `k_toast_${payload.peerIdSafe}_${Date.now()}`,
        peerTag: payload.peerTag || payload.peerIdSafe,
        peerIdSafe: payload.peerIdSafe,
        displayName: payload.displayName || 'Guest',
        avatarUrl: '',
        timestamp: Date.now(),
        hubTopic: hubRef.current,
      };

      if (payload.action === 'accept') {
        void acceptKnock(knockTarget);
      } else if (payload.action === 'reject') {
        void rejectKnock(knockTarget);
      }
    },
    [acceptKnock, hubRef, onRestoreHub, rejectKnock, roleRef]
  );

  const executeToastActionRef = useRef(executeToastAction);
  executeToastActionRef.current = executeToastAction;

  // Register active owner room in Rust ToastState and drain any queued accept actions once ready.
  useEffect(() => {
    if (resolvedRole !== 'owner' || !normalizedHub || hasLeftRoom || waitingForProfile) {
      deferredToastActionsRef.current = [];
      return;
    }

    let cancelled = false;
    let unlisten: (() => void) | null = null;
    deferredToastActionsRef.current = [];

    const handleLiveToastAction = async (payload: KnockToastActionPayload): Promise<void> => {
      if (cancelled || roleRef.current !== 'owner' || !hubRef.current) return;
      if (payload.hubId && normalizeHubTopic(payload.hubId) !== hubRef.current) return;

      const claimed = await claimToastActionTauri(payload.actionId);
      if (!claimed || cancelled) return;

      if (payload.action === 'accept' && !isRoomReadyRef.current) {
        deferredToastActionsRef.current.push(payload);
        return;
      }
      executeToastActionRef.current(payload);
    };

    const bindOwnerToastSession = async (): Promise<void> => {
      const fn = await listenKnockToastActionTauri((payload) => {
        void handleLiveToastAction(payload);
      });
      if (cancelled) {
        fn();
        return;
      }
      unlisten = fn;

      await registerOwnerRoomSessionTauri(normalizedHub);
      void localWindowBus.publish({
        type: 'owner_room_status',
        hubId: normalizedHub,
        active: true,
      });

      const pendingActions = await consumePendingToastActionsTauri(normalizedHub);
      if (cancelled || pendingActions.length === 0) return;

      if (!isRoomReadyRef.current) {
        deferredToastActionsRef.current.push(...pendingActions);
        return;
      }

      await signalingTransport.connect();
      if (cancelled) return;
      for (const action of pendingActions) {
        executeToastActionRef.current(action);
      }
    };

    void bindOwnerToastSession();

    return () => {
      cancelled = true;
      unlisten?.();
      void unregisterOwnerRoomSessionTauri(normalizedHub);
      void localWindowBus.publish({
        type: 'owner_room_status',
        hubId: normalizedHub,
        active: false,
      });
    };
  }, [hasLeftRoom, hubRef, normalizedHub, resolvedRole, roleRef, waitingForProfile]);

  // Execute consumed toast actions once the room has finished MQTT setup & initial owner roster init.
  useEffect(() => {
    if (!isRoomReady || resolvedRole !== 'owner' || hasLeftRoom) return;
    const queued = deferredToastActionsRef.current.splice(0);
    if (queued.length === 0) return;

    let cancelled = false;
    void signalingTransport.connect().then(() => {
      if (cancelled) return;
      for (const action of queued) {
        executeToastActionRef.current(action);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [hasLeftRoom, isRoomReady, resolvedRole]);

  return {
    knockStatus,
    knockError,
    entranceAccepted,
    pendingKnocks,
    entranceAcceptedRef,
    sendKnockRequest,
    cancelKnock,
    acceptKnock,
    rejectKnock,
    handleIncomingKnockRequest,
    handleKnockDecision,
    detachTransientKnockSub,
    clearKnockGateTimers,
    markOwnerAccepted,
    markGuestKnocking,
    onHostLeftRoom,
    resetKnockGateState,
  };
};
