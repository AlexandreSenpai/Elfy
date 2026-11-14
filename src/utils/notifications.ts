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

const getAudioContextConstructor = (): typeof AudioContext | null => {
  if (typeof window === 'undefined') return null;
  const win = window as unknown as NotificationWindowGlobals;
  return window.AudioContext ?? win.webkitAudioContext ?? null;
};

let sharedAudioCtx: AudioContext | null = null;

/**
 * Plays a gentle two-tone chime to alert the hub owner of an incoming knock request.
 */
export const playKnockSound = (): void => {
  if (typeof window === 'undefined') return;
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
    void showKnockNotificationTauri(cleanName, cleanTag);
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
