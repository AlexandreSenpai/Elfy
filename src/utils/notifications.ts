import { sendNotification } from '@tauri-apps/plugin-notification';
import { isTauri, showKnockNotificationTauri } from './tauri';

export interface RecordedKnockNotification {
  title: string;
  body: string;
  peerTag: string;
  timestamp: number;
}

interface NotificationWindowGlobals {
  __ELFY_KNOCK_SOUNDS_PLAYED__?: number;
  __ELFY_NOTIFICATIONS_SHOWN__?: RecordedKnockNotification[];
  webkitAudioContext?: typeof AudioContext;
}

const KNOCK_DEDUP_STORAGE_KEY = 'elfy_last_knock_alert';
const KNOCK_DEDUP_WINDOW_MS = 1200;
const recentKnockSoundMap = new Map<string, number>();
const recentKnockNotifyMap = new Map<string, number>();

const shouldDeduplicateKnock = (
  kind: 'sound' | 'notify',
  key: string,
  localMap: Map<string, number>
): boolean => {
  const now = Date.now();
  const normalizedKey = `${kind}:${key.trim().toLowerCase() || 'unknown'}`;
  const lastLocal = localMap.get(normalizedKey) ?? 0;
  if (now - lastLocal < KNOCK_DEDUP_WINDOW_MS) {
    return true;
  }
  localMap.set(normalizedKey, now);

  if (typeof localStorage !== 'undefined') {
    try {
      const storageKey = `${KNOCK_DEDUP_STORAGE_KEY}_${normalizedKey}`;
      const prev = Number(localStorage.getItem(storageKey) ?? '0');
      if (Number.isFinite(prev) && now - prev < KNOCK_DEDUP_WINDOW_MS) {
        return true;
      }
      localStorage.setItem(storageKey, String(now));
    } catch {
      // Ignore localStorage quota/access errors.
    }
  }

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
export const playKnockSound = (dedupKey?: string): void => {
  if (typeof window === 'undefined') return;
  if (dedupKey && shouldDeduplicateKnock('sound', dedupKey, recentKnockSoundMap)) {
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
export const showKnockNotification = (displayName: string, peerTag: string): void => {
  const cleanName = displayName.trim() || 'Someone';
  const cleanTag = peerTag.trim();
  if (shouldDeduplicateKnock('notify', cleanTag || cleanName, recentKnockNotifyMap)) {
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
    win.__ELFY_NOTIFICATIONS_SHOWN__.push({
      title,
      body,
      peerTag: cleanTag,
      timestamp: Date.now(),
    });
  }

  if (isTauri()) {
    void showKnockNotificationTauri(cleanName, cleanTag).catch(() => {
      try {
        sendNotification({ title, body });
      } catch {
        // Ignore secondary plugin error.
      }
    });
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
