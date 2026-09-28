import { useState, useCallback, useEffect } from 'react';
import { useBroker } from './useBroker';
import { UserProfile } from '../types';
import { KnockStatus, PendingKnock } from '../types/knock';
import {
  toSafePeerTag,
  formatFullPeerTag,
  normalizeHubTopic,
  getKnockTopic,
  getGuestInboxTopic,
  extractHostFromHub
} from '../utils/hubTopics';

export const useHubKnocking = (
  hubId: string,
  profile: UserProfile,
  joinedAs: 'owner' | 'guest'
) => {
  const broker = useBroker();
  const normalizedHub = normalizeHubTopic(hubId);
  const hostInfo = extractHostFromHub(hubId);

  const [knockStatus, setKnockStatus] = useState<KnockStatus>('idle');
  const [entranceAccepted, setEntranceAccepted] = useState(false);
  const [pendingKnocks, setPendingKnocks] = useState<PendingKnock[]>([]);

  const requestHubEntrance = useCallback(async () => {
    if (!normalizedHub || !profile || joinedAs !== 'guest') return;

    const guestTagSafe = toSafePeerTag(profile.nickname, profile.peerTag);
    const inbox = getGuestInboxTopic(normalizedHub, guestTagSafe);
    const knockTopic = getKnockTopic(normalizedHub);

    setKnockStatus('knocking');
    setEntranceAccepted(false);

    await broker.subscribeTo(inbox);
    await broker.dispatchMessage(knockTopic, {
      type: 'knock',
      peerTag: formatFullPeerTag(profile.nickname, profile.peerTag),
      peerIdSafe: guestTagSafe,
      displayName: profile.nickname,
      avatarUrl: profile.avatarUrl,
      timestamp: Date.now()
    });
  }, [normalizedHub, profile, joinedAs, broker]);

  const cancelKnock = useCallback(() => {
    setKnockStatus('idle');
  }, []);

  const acceptKnock = useCallback(async (knock: PendingKnock) => {
    const target = getGuestInboxTopic(normalizedHub, knock.peerIdSafe);
    await broker.dispatchMessage(target, { type: 'knock_accepted' });
    setPendingKnocks((prev) => prev.filter((k) => k.peerIdSafe !== knock.peerIdSafe));
  }, [normalizedHub, broker]);

  const rejectKnock = useCallback(async (knock: PendingKnock) => {
    const target = getGuestInboxTopic(normalizedHub, knock.peerIdSafe);
    await broker.dispatchMessage(target, { type: 'knock_rejected' });
    setPendingKnocks((prev) => prev.filter((k) => k.peerIdSafe !== knock.peerIdSafe));
  }, [normalizedHub, broker]);

  const hubOwnerKnockHandler = async () => {
    broker.subscribeTo(getKnockTopic(normalizedHub));

    const unlisten = broker.listenToMessages(async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type !== 'knock') {
          return
        }
        
        const peerIdSafe = data.peerIdSafe || toSafePeerTag(data.displayName || 'Guest', data.peerTag || '');
        const newKnock: PendingKnock = {
          id: `k_${peerIdSafe}_${data.timestamp || Date.now()}`,
          peerTag: data.peerTag || 'Guest',
          peerIdSafe,
          displayName: data.displayName || 'Guest',
          avatarUrl: data.avatarUrl,
          timestamp: data.timestamp || Date.now(),
          hubTopic: normalizedHub
        };
        setPendingKnocks((prev) => [newKnock, ...prev.filter((k) => k.peerIdSafe !== peerIdSafe)]);
      } catch (err) {
        console.error(err);
      }
    });

    return unlisten;
  }

  const hubGuestKnockHandler = async () => {
    const unlisten = broker.listenToMessages(async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

        if (data.type === 'knock_accepted' || data.type === 'answer_accepted') {
          setKnockStatus('accepted');
          setEntranceAccepted(true);
        } else if (data.type === 'knock_rejected' || data.type === 'answer_rejected') {
          setKnockStatus('rejected');
          setEntranceAccepted(false);
        }
      } catch (err) {
        console.error(err);
      }
    });

    return unlisten;
  }
  useEffect(() => {
    if (!normalizedHub) return;

    let unlistenPromise: Promise<(() => void) | undefined> | undefined;

    if (joinedAs === 'owner') {
      unlistenPromise = hubOwnerKnockHandler();
    } else {
      unlistenPromise = hubGuestKnockHandler();
    }

    return () => {
      unlistenPromise?.then((unlisten) => {
        if (unlisten) unlisten();
      });
    };
  }, [broker, joinedAs, normalizedHub]);

  return {
    hostInfo,
    hubTopic: normalizedHub,
    knockStatus,
    entranceAccepted,
    pendingKnocks,
    requestHubEntrance,
    cancelKnock,
    acceptKnock,
    rejectKnock
  };
};

export default useHubKnocking;
