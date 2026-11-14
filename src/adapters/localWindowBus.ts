import { emit, listen, UnlistenFn } from '@tauri-apps/api/event';
import { SIGNALING_CONFIG } from '../domain/config';
import { LocalWindowBusMessage } from '../domain/dtos';
import { isRecord, parseLocalBusMessage } from '../domain/validators';
import { ILocalWindowBus, LocalWindowBusHandler } from '../ports';
import { isTauri } from '../utils/tauri';

const TAURI_LOCAL_BUS_EVENT = 'elfy:local-window-bus';
const TEST_MACHINE_UID_KEY = 'elfy_test_machine_uid';

interface LocalBusWireEnvelope {
  senderId: string;
  scopeId: string;
  payload: LocalWindowBusMessage;
}

const createTabInstanceId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `tab-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
};

const getLocalScopeId = (): string => {
  if (isTauri()) return 'tauri';
  if (typeof sessionStorage === 'undefined') return 'browser-default';
  return sessionStorage.getItem(TEST_MACHINE_UID_KEY) || 'browser-default';
};

/**
 * Cross-window event bus bridging Tauri IPC events and same-peer BroadcastChannel
 * with strict runtime validation and peer scope isolation.
 */
export class LocalWindowBus implements ILocalWindowBus {
  private readonly tabId = createTabInstanceId();
  private handlers = new Set<LocalWindowBusHandler>();
  private channel: BroadcastChannel | null = null;
  private tauriUnlisten: UnlistenFn | null = null;
  private initialized = false;

  private ensureInitialized(): void {
    if (this.initialized) return;
    this.initialized = true;

    if (isTauri()) {
      void this.attachTauriListener();
      return;
    }

    if (typeof BroadcastChannel === 'undefined') return;
    const channel = new BroadcastChannel(SIGNALING_CONFIG.LOCAL_BUS_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      this.handleIncomingEnvelope(event.data);
    };
    this.channel = channel;
  }

  private async attachTauriListener(): Promise<void> {
    if (this.tauriUnlisten) return;
    try {
      this.tauriUnlisten = await listen<unknown>(TAURI_LOCAL_BUS_EVENT, (event) => {
        this.handleIncomingEnvelope(event.payload);
      });
    } catch (err) {
      console.warn('[LocalWindowBus] Failed to bind Tauri event listener:', err);
    }
  }

  private handleIncomingEnvelope(raw: unknown): void {
    if (!isRecord(raw)) return;
    if (raw.senderId === this.tabId) return;
    if (!isTauri() && raw.scopeId !== getLocalScopeId()) return;

    const message = parseLocalBusMessage(raw.payload);
    if (!message) return;
    this.notifyLocalHandlers(message);
  }

  private notifyLocalHandlers(message: LocalWindowBusMessage): void {
    for (const handler of Array.from(this.handlers)) {
      try {
        handler(message);
      } catch (err) {
        console.error('[LocalWindowBus] Subscriber error:', err);
      }
    }
  }

  async publish(message: LocalWindowBusMessage): Promise<void> {
    this.ensureInitialized();
    this.notifyLocalHandlers(message);

    const envelope: LocalBusWireEnvelope = {
      senderId: this.tabId,
      scopeId: getLocalScopeId(),
      payload: message,
    };

    if (isTauri()) {
      await emit(TAURI_LOCAL_BUS_EVENT, envelope).catch(() => {});
      return;
    }

    this.channel?.postMessage(envelope);
  }

  subscribe(handler: LocalWindowBusHandler): () => void {
    this.ensureInitialized();
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }
}

export const localWindowBus: ILocalWindowBus = new LocalWindowBus();
