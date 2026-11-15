import { isTauri, showKnockNotificationTauri } from './tauri';

export interface KnockNotificationMeta {
  peerIdSafe?: string;
  hubId?: string;
  replyTopic?: string;
  messageId?: string;
}

export interface RecordedKnockNotification {
  title: string;
  body: string;
  peerTag: string;
  peerIdSafe?: string;
  hubId?: string;
  replyTopic?: string;
  messageId?: string;
  actions: string[];
  timestamp: number;
}

interface NotificationWindowGlobals {
  __ELFY_KNOCK_SOUNDS_PLAYED__?: number;
  __ELFY_NOTIFICATIONS_SHOWN__?: RecordedKnockNotification[];
  __ELFY_LAST_KNOCK_NOTIFICATION__?: RecordedKnockNotification;
  webkitAudioContext?: typeof AudioContext;
}

const KNOCK_DEDUP_STORAGE_KEY = 'elfy_knock_dedup_v2';
const PEER_DEDUP_WINDOW_MS = 2_500;
const MESSAGE_DEDUP_WINDOW_MS = 60_000;
const MAX_STORED_DEDUP_ENTRIES = 24;

interface DedupEntry {
  key: string;
  ts: number;
  ttlMs: number;
}

const recentKnockSoundMap = new Map<string, DedupEntry>();
const recentKnockNotifyMap = new Map<string, DedupEntry>();

const pruneDedupMap = (map: Map<string, DedupEntry>, now: number): void => {
  for (const [k, entry] of map.entries()) {
    if (now - entry.ts >= entry.ttlMs) {
      map.delete(k);
    }
  }
};

const readStorageDedupEntries = (kind: 'sound' | 'notify', now: number): DedupEntry[] => {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(`${KNOCK_DEDUP_STORAGE_KEY}_${kind}`);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is DedupEntry =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as DedupEntry).key === 'string' &&
        typeof (item as DedupEntry).ts === 'number' &&
        typeof (item as DedupEntry).ttlMs === 'number' &&
        now - (item as DedupEntry).ts < (item as DedupEntry).ttlMs
    );
  } catch {
    return [];
  }
};

const writeStorageDedupEntries = (kind: 'sound' | 'notify', entries: DedupEntry[]): void => {
  if (typeof localStorage === 'undefined') return;
  try {
    const trimmed = entries.slice(-MAX_STORED_DEDUP_ENTRIES);
    localStorage.setItem(`${KNOCK_DEDUP_STORAGE_KEY}_${kind}`, JSON.stringify(trimmed));
  } catch {
    // Ignore localStorage quota/access errors.
  }
};

const shouldDeduplicateKnock = (
  kind: 'sound' | 'notify',
  peerKeyRaw: string,
  localMap: Map<string, DedupEntry>,
  messageId?: string
): boolean => {
  const now = Date.now();
  pruneDedupMap(localMap, now);

  const normalizedPeerKey = `peer:${peerKeyRaw.trim().toLowerCase() || 'unknown'}`;
  const cleanMsgId = messageId?.trim();
  const normalizedMsgKey = cleanMsgId ? `msg:${cleanMsgId}` : null;

  const existingPeer = localMap.get(normalizedPeerKey);
  if (existingPeer && now - existingPeer.ts < PEER_DEDUP_WINDOW_MS) {
    return true;
  }
  if (normalizedMsgKey) {
    const existingMsg = localMap.get(normalizedMsgKey);
    if (existingMsg && now - existingMsg.ts < MESSAGE_DEDUP_WINDOW_MS) {
      return true;
    }
  }

  const stored = readStorageDedupEntries(kind, now);
  if (
    stored.some(
      (entry) =>
        (entry.key === normalizedPeerKey && now - entry.ts < PEER_DEDUP_WINDOW_MS) ||
        (normalizedMsgKey !== null && entry.key === normalizedMsgKey && now - entry.ts < MESSAGE_DEDUP_WINDOW_MS)
    )
  ) {
    localMap.set(normalizedPeerKey, { key: normalizedPeerKey, ts: now, ttlMs: PEER_DEDUP_WINDOW_MS });
    if (normalizedMsgKey) {
      localMap.set(normalizedMsgKey, { key: normalizedMsgKey, ts: now, ttlMs: MESSAGE_DEDUP_WINDOW_MS });
    }
    return true;
  }

  const peerEntry: DedupEntry = { key: normalizedPeerKey, ts: now, ttlMs: PEER_DEDUP_WINDOW_MS };
  localMap.set(normalizedPeerKey, peerEntry);
  const nextStored = stored.filter(
    (entry) => entry.key !== normalizedPeerKey && entry.key !== normalizedMsgKey
  );
  nextStored.push(peerEntry);

  if (normalizedMsgKey) {
    const msgEntry: DedupEntry = { key: normalizedMsgKey, ts: now, ttlMs: MESSAGE_DEDUP_WINDOW_MS };
    localMap.set(normalizedMsgKey, msgEntry);
    nextStored.push(msgEntry);
  }
  writeStorageDedupEntries(kind, nextStored);

  return false;
};

const getAudioContextConstructor = (): typeof AudioContext | null => {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as NotificationWindowGlobals;
  return window.AudioContext ?? win.webkitAudioContext ?? null;
};

let sharedAudioCtx: AudioContext | null = null;

/**
 * Plays a gentle two-tone chime to alert the hub owner of an incoming knock request.
 */
export const playKnockSound = (dedupKey?: string, messageId?: string): void => {
  if (typeof window === 'undefined') return;
  if (
    (dedupKey || messageId) &&
    shouldDeduplicateKnock('sound', dedupKey || messageId || 'knock', recentKnockSoundMap, messageId)
  ) {
    return;
  }

  const win = window as unknown as NotificationWindowGlobals;
  win.__ELFY_KNOCK_SOUNDS_PLAYED__ = (win.__ELFY_KNOCK_SOUNDS_PLAYED__ ?? 0) + 1;

  try {
    const AudioCtx = getAudioContextConstructor();
    if (!AudioCtx) return;

    if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
      sharedAudioCtx = new AudioCtx();
    }
    const ctx = sharedAudioCtx;
    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => {});
    }

    const now = ctx.currentTime;
    const notes = [
      { freq: 587.33, startOffset: 0, duration: 0.14 },
      { freq: 880.0, startOffset: 0.12, duration: 0.28 },
    ];

    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, now + note.startOffset);

      gain.gain.setValueAtTime(0.0001, now + note.startOffset);
      gain.gain.exponentialRampToValueAtTime(0.16, now + note.startOffset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.startOffset + note.duration);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + note.startOffset);
      osc.stop(now + note.startOffset + note.duration + 0.02);
    }
  } catch {
    // Ignore audio context autoplay/platform errors so signaling never fails.
  }
};

/**
 * Sends a Windows OS notification (in Tauri) and/or Web Notification when a user knocks.
 */
export const showKnockNotification = (
  displayName: string,
  peerTag: string,
  meta?: KnockNotificationMeta
): void => {
  const cleanName = displayName.trim() || 'Someone';
  const cleanTag = peerTag.trim();
  if (
    shouldDeduplicateKnock(
      'notify',
      meta?.peerIdSafe || cleanTag || cleanName,
      recentKnockNotifyMap,
      meta?.messageId
    )
  ) {
    return;
  }

  const title = 'Elfy — Knock Request';
  const body = cleanTag
    ? `${cleanName} (${cleanTag}) wants to join your Hub`
    : `${cleanName} wants to join your Hub`;

  if (typeof window !== 'undefined') {
    const win = window as unknown as NotificationWindowGlobals;
    if (!Array.isArray(win.__ELFY_NOTIFICATIONS_SHOWN__)) {
      win.__ELFY_NOTIFICATIONS_SHOWN__ = [];
    }
    const recorded: RecordedKnockNotification = {
      title,
      body,
      peerTag: cleanTag,
      peerIdSafe: meta?.peerIdSafe,
      hubId: meta?.hubId,
      replyTopic: meta?.replyTopic,
      messageId: meta?.messageId,
      actions: ['Allow', 'Decline'],
      timestamp: Date.now(),
    };
    win.__ELFY_NOTIFICATIONS_SHOWN__.push(recorded);
    win.__ELFY_LAST_KNOCK_NOTIFICATION__ = recorded;
  }

  if (isTauri()) {
    void showKnockNotificationTauri({
      displayName: cleanName,
      peerTag: cleanTag,
      peerIdSafe: meta?.peerIdSafe,
      hubId: meta?.hubId,
      replyTopic: meta?.replyTopic,
      messageId: meta?.messageId,
    }).catch(() => {});
    return;
  }

  if (typeof Notification === 'undefined') return;

  const fireBrowserNotification = (): void => {
    try {
      new Notification(title, {
        body,
        tag: `elfy-knock-${cleanTag || cleanName}`,
      });
    } catch {
      // Ignore browser Notification API errors in restricted contexts.
    }
  };

  if (Notification.permission === 'granted') {
    fireBrowserNotification();
  } else if (Notification.permission === 'default' && typeof Notification.requestPermission === 'function') {
    void Notification.requestPermission()
      .then((perm) => {
        if (perm === 'granted') fireBrowserNotification();
      })
      .catch(() => {});
  }
};
