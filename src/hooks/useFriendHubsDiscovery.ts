import { useCallback, useEffect, useRef, useState } from 'react';
import { localWindowBus, signalingTransport, storageRepository } from '../adapters';
import {
  ActiveMinimizedHubDto,
  FriendHubLiveStatusDto,
  FriendHubRecordDto,
  FriendHubViewModel,
  HubStatusRequestPayload,
  LocalWindowBusMessage,
  LocalWindowBusMessageType,
  SignalingEnvelopeDto,
  UserProfile,
} from '../domain/dtos';
import { sanitizeHubCode } from '../domain/validators';
import {
  extractHostFromHub,
  getGuestInboxTopic,
  getProbeTopic,
  normalizeHubTopic,
  toSafePeerTag,
} from '../utils/hubTopics';
import { isTauri, restoreStreamWindowTauri } from '../utils/tauri';

export interface AddFriendHubMeta {
  ownerNickname?: string;
  ownerTag?: string;
  ownerAvatar?: string;
  isFavorite?: boolean;
}

export interface UseFriendHubsDiscoveryResult {
  hubs: FriendHubViewModel[];
  isProbing: boolean;
  minimizedHub: ActiveMinimizedHubDto | null;
  refreshHubsStatus: () => Promise<void>;
  addFriendHub: (hubInput: string, meta?: AddFriendHubMeta) => Promise<FriendHubViewModel | null>;
  removeFriendHub: (hubId: string) => Promise<void>;
  restoreMinimizedHub: () => Promise<void>;
  disconnectMinimizedHub: () => Promise<void>;
}

const PROBE_TIMEOUT_MS = 1500;

const createId = (prefix: string): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
};

const toCanonicalHubId = (hubId: string): string => {
  return normalizeHubTopic(hubId) || hubId.trim();
};

const toViewModel = (
  record: FriendHubRecordDto,
  live?: FriendHubLiveStatusDto
): FriendHubViewModel => ({
  hubId: record.hubId,
  ownerNickname: record.ownerNickname,
  ownerTag: record.ownerTag,
  ownerAvatar: record.ownerAvatar,
  lastJoinedAt: record.lastJoinedAt,
  isFavorite: record.isFavorite,
  status: live?.status ?? 'offline',
  peers: live?.peers ?? 0,
  streamerNames: live?.streamerNames ?? [],
  latencyMs: live?.latencyMs ?? 0,
});

const mergeRecordsWithLive = (
  records: FriendHubRecordDto[],
  liveMap: Map<string, FriendHubLiveStatusDto>
): FriendHubViewModel[] => {
  return records.map((record) => {
    const canonical = toCanonicalHubId(record.hubId);
    return toViewModel(record, liveMap.get(canonical));
  });
};

type BusHandler = (message: LocalWindowBusMessage) => void;

/**
 * Discovers saved Friend Hubs via SQLite/test storage and active MQTT/BroadcastChannel
 * probes, and tracks minimized room banner state across windows.
 */
export const useFriendHubsDiscovery = (profile: UserProfile): UseFriendHubsDiscoveryResult => {
  const [hubs, setHubs] = useState<FriendHubViewModel[]>([]);
  const [isProbing, setIsProbing] = useState<boolean>(false);
  const [minimizedHub, setMinimizedHub] = useState<ActiveMinimizedHubDto | null>(null);

  const localPeerIdSafe = toSafePeerTag(profile.nickname, profile.peerTag);
  const localPeerIdRef = useRef<string>(localPeerIdSafe);
  localPeerIdRef.current = localPeerIdSafe;

  const recordsRef = useRef<FriendHubRecordDto[]>([]);
  const liveMapRef = useRef<Map<string, FriendHubLiveStatusDto>>(new Map());
  const minimizedHubRef = useRef<ActiveMinimizedHubDto | null>(null);
  minimizedHubRef.current = minimizedHub;

  const inboxUnsubMapRef = useRef<Map<string, () => void>>(new Map());
  const pendingHubIdsRef = useRef<Set<string>>(new Set());
  const requestSentAtRef = useRef<Map<string, number>>(new Map());
  const probeTimerRef = useRef<number | null>(null);
  const probeGenerationRef = useRef<number>(0);
  const mountedRef = useRef<boolean>(true);

  const clearProbeTimer = useCallback((): void => {
    if (probeTimerRef.current === null) return;
    window.clearTimeout(probeTimerRef.current);
    probeTimerRef.current = null;
  }, []);

  const syncViewModels = useCallback((records: FriendHubRecordDto[]): void => {
    recordsRef.current = records;
    if (!mountedRef.current) return;
    setHubs(mergeRecordsWithLive(records, liveMapRef.current));
  }, []);

  const handleProbeResponseEnvelope = useCallback(
    (envelope: SignalingEnvelopeDto): void => {
      if (envelope.payload.type !== 'hub_status_response') return;
      const payload = envelope.payload;
      const canonicalHub = toCanonicalHubId(payload.hubId);
      const sentAt = requestSentAtRef.current.get(payload.requestId) ?? envelope.sentAt;
      const latencyMs = Math.max(1, Date.now() - sentAt);

      liveMapRef.current.set(canonicalHub, {
        hubId: canonicalHub,
        status: payload.status,
        peers: payload.peers,
        streamerNames: payload.streamerNames,
        latencyMs,
        updatedAt: Date.now(),
      });

      pendingHubIdsRef.current.delete(canonicalHub);
      syncViewModels(recordsRef.current);

      if (pendingHubIdsRef.current.size > 0) return;
      clearProbeTimer();
      if (mountedRef.current) setIsProbing(false);
    },
    [clearProbeTimer, syncViewModels]
  );

  const subscribeSingleInbox = useCallback(
    async (topic: string): Promise<void> => {
      if (inboxUnsubMapRef.current.has(topic)) return;
      const unsub = await signalingTransport.subscribeTopic(topic, (envelope) => {
        handleProbeResponseEnvelope(envelope);
      });
      if (!mountedRef.current) {
        unsub();
        return;
      }
      inboxUnsubMapRef.current.set(topic, unsub);
    },
    [handleProbeResponseEnvelope]
  );

  const ensureInboxSubscriptions = useCallback(
    async (records: FriendHubRecordDto[]): Promise<void> => {
      const peerSafe = localPeerIdRef.current;
      const desiredTopics = new Set<string>();

      for (const record of records) {
        const inboxTopic = getGuestInboxTopic(record.hubId, peerSafe);
        if (inboxTopic) desiredTopics.add(inboxTopic);
      }

      for (const [topic, unsub] of Array.from(inboxUnsubMapRef.current.entries())) {
        if (desiredTopics.has(topic)) continue;
        unsub();
        inboxUnsubMapRef.current.delete(topic);
      }

      for (const topic of desiredTopics) {
        await subscribeSingleInbox(topic);
      }
    },
    [subscribeSingleInbox]
  );

  const markPendingHubsOffline = useCallback((): void => {
    for (const hubId of pendingHubIdsRef.current) {
      liveMapRef.current.set(hubId, {
        hubId,
        status: 'offline',
        peers: 0,
        streamerNames: [],
        latencyMs: 0,
        updatedAt: Date.now(),
      });
    }
    pendingHubIdsRef.current.clear();
    syncViewModels(recordsRef.current);
    setIsProbing(false);
  }, [syncViewModels]);

  const dispatchSingleProbe = useCallback((record: FriendHubRecordDto): string | null => {
    const canonicalHub = toCanonicalHubId(record.hubId);
    const probeTopic = getProbeTopic(canonicalHub);
    const peerSafe = localPeerIdRef.current;
    const replyTopic = getGuestInboxTopic(canonicalHub, peerSafe);
    if (!probeTopic || !replyTopic) return null;

    const requestId = createId('probe');
    requestSentAtRef.current.set(requestId, Date.now());

    const envelope: SignalingEnvelopeDto<HubStatusRequestPayload> = {
      version: 1,
      messageId: createId('msg'),
      hubId: canonicalHub,
      senderPeerIdSafe: peerSafe,
      sentAt: Date.now(),
      payload: {
        type: 'hub_status_request',
        requesterIdSafe: peerSafe,
        replyTopic,
        requestId,
      },
    };

    void signalingTransport.publish(probeTopic, envelope);
    return canonicalHub;
  }, []);

  const probeRecords = useCallback(
    async (records: FriendHubRecordDto[]): Promise<void> => {
      probeGenerationRef.current += 1;
      const roundId = probeGenerationRef.current;
      clearProbeTimer();
      syncViewModels(records);

      if (records.length === 0) {
        pendingHubIdsRef.current.clear();
        if (mountedRef.current) setIsProbing(false);
        return;
      }

      if (mountedRef.current) setIsProbing(true);
      await signalingTransport.connect();
      await ensureInboxSubscriptions(records);
      if (!mountedRef.current || probeGenerationRef.current !== roundId) return;

      const pending = new Set<string>();
      requestSentAtRef.current.clear();

      for (const record of records) {
        const probedHub = dispatchSingleProbe(record);
        if (probedHub) pending.add(probedHub);
      }

      pendingHubIdsRef.current = pending;
      if (pending.size === 0) {
        if (mountedRef.current) setIsProbing(false);
        return;
      }

      probeTimerRef.current = window.setTimeout(() => {
        if (!mountedRef.current || probeGenerationRef.current !== roundId) return;
        markPendingHubsOffline();
      }, PROBE_TIMEOUT_MS);
    },
    [
      clearProbeTimer,
      dispatchSingleProbe,
      ensureInboxSubscriptions,
      markPendingHubsOffline,
      syncViewModels,
    ]
  );

  const refreshHubsStatus = useCallback(async (): Promise<void> => {
    try {
      const records = await storageRepository.listFriendHubs();
      await probeRecords(records);
    } catch (err) {
      console.warn('[useFriendHubsDiscovery] Failed to refresh hubs:', err);
      if (mountedRef.current) setIsProbing(false);
    }
  }, [probeRecords]);

  const addFriendHub = useCallback(
    async (hubInput: string, meta?: AddFriendHubMeta): Promise<FriendHubViewModel | null> => {
      const normalizedHub = sanitizeHubCode(hubInput);
      if (!normalizedHub) return null;

      const hostInfo = extractHostFromHub(normalizedHub);
      const existing = recordsRef.current.find(
        (item) => toCanonicalHubId(item.hubId) === normalizedHub
      );

      const record: FriendHubRecordDto = {
        hubId: normalizedHub,
        ownerNickname: meta?.ownerNickname?.trim() || existing?.ownerNickname || hostInfo.displayName,
        ownerTag: meta?.ownerTag?.trim() || existing?.ownerTag || hostInfo.tag,
        ownerAvatar: meta?.ownerAvatar ?? existing?.ownerAvatar ?? '',
        lastJoinedAt: Date.now(),
        isFavorite: meta?.isFavorite ?? existing?.isFavorite ?? false,
      };

      const updated = await storageRepository.upsertFriendHub(record);
      await probeRecords(updated);
      const saved = updated.find((item) => toCanonicalHubId(item.hubId) === normalizedHub) ?? record;
      return toViewModel(saved, liveMapRef.current.get(normalizedHub));
    },
    [probeRecords]
  );

  const removeFriendHub = useCallback(
    async (hubId: string): Promise<void> => {
      const canonical = toCanonicalHubId(hubId);
      liveMapRef.current.delete(canonical);
      const updated = await storageRepository.removeFriendHub(hubId);
      const filtered =
        updated.length === recordsRef.current.length && canonical !== hubId
          ? await storageRepository.removeFriendHub(canonical)
          : updated;
      await ensureInboxSubscriptions(filtered);
      syncViewModels(filtered);
    },
    [ensureInboxSubscriptions, syncViewModels]
  );

  const restoreMinimizedHub = useCallback(async (): Promise<void> => {
    const target = minimizedHubRef.current;
    if (!target) return;

    await localWindowBus.publish({ type: 'restore_hub_requested', hubId: target.hubId });
    if (isTauri()) {
      await restoreStreamWindowTauri();
    }
  }, []);

  const disconnectMinimizedHub = useCallback(async (): Promise<void> => {
    const target = minimizedHubRef.current;
    if (!target) return;

    setMinimizedHub(null);
    await localWindowBus.publish({ type: 'disconnect_hub_requested', hubId: target.hubId });
    await localWindowBus.publish({ type: 'minimized_hub_cleared', hubId: target.hubId });
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    const busHandlers: Record<LocalWindowBusMessageType, BusHandler> = {
      profile_updated: () => {},
      minimized_hub_updated: (msg) => {
        if (msg.type !== 'minimized_hub_updated') return;
        setMinimizedHub(msg.hub);
      },
      minimized_hub_cleared: (msg) => {
        if (msg.type !== 'minimized_hub_cleared') return;
        const clearedId = toCanonicalHubId(msg.hubId);
        setMinimizedHub((prev) => {
          if (!prev) return null;
          return toCanonicalHubId(prev.hubId) === clearedId ? null : prev;
        });
      },
      restore_hub_requested: () => {},
      disconnect_hub_requested: () => {},
    };

    const unsubBus = localWindowBus.subscribe((message) => {
      busHandlers[message.type](message);
    });

    const handleFocus = (): void => {
      if (document.hidden) return;
      void refreshHubsStatus();
    };

    window.addEventListener('focus', handleFocus);
    document.addEventListener('visibilitychange', handleFocus);

    return () => {
      mountedRef.current = false;
      unsubBus();
      window.removeEventListener('focus', handleFocus);
      document.removeEventListener('visibilitychange', handleFocus);
      clearProbeTimer();
      for (const unsub of inboxUnsubMapRef.current.values()) {
        unsub();
      }
      inboxUnsubMapRef.current.clear();
    };
  }, [clearProbeTimer, refreshHubsStatus]);

  useEffect(() => {
    for (const unsub of inboxUnsubMapRef.current.values()) {
      unsub();
    }
    inboxUnsubMapRef.current.clear();
    void refreshHubsStatus();
  }, [localPeerIdSafe, refreshHubsStatus]);

  return {
    hubs,
    isProbing,
    minimizedHub,
    refreshHubsStatus,
    addFriendHub,
    removeFriendHub,
    restoreMinimizedHub,
    disconnectMinimizedHub,
  };
};

export default useFriendHubsDiscovery;
