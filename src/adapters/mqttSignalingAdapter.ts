import mqtt, { MqttClient } from 'mqtt';
import { SIGNALING_CONFIG } from '../domain/config';
import { SignalingEnvelopeDto, SignalingPayload } from '../domain/dtos';
import { isRecord, parseSignalingEnvelope } from '../domain/validators';
import {
  ConnectionStateListener,
  ISignalingTransport,
  TopicMessageHandler,
} from '../ports';

const MAX_SEEN_IDS = 500;
const MAX_PENDING_PUBLISHES = 100;

interface PendingPublish {
  topic: string;
  body: string;
}

const normalizeMqttTopic = (topic: string): string => {
  return topic.trim().replace(/#/g, '_');
};

const invokeTopicHandler = async (
  handler: TopicMessageHandler,
  envelope: SignalingEnvelopeDto,
  topic: string
): Promise<void> => {
  try {
    await handler(envelope, topic);
  } catch (err) {
    console.error(`[Signaling] Handler error for topic "${topic}":`, err);
  }
};

/**
 * Topic-routed singleton signaling transport over EMQX WebSocket MQTT
 * bridged with BroadcastChannel for deterministic local & Playwright signaling.
 */
export class MqttSignalingAdapter implements ISignalingTransport {
  private client: MqttClient | null = null;
  private connectPromise: Promise<boolean> | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  private topicHandlers = new Map<string, Set<TopicMessageHandler>>();
  private connectionListeners = new Set<ConnectionStateListener>();
  private seenQueue: string[] = [];
  private seenSet = new Set<string>();
  private pendingPublishes: PendingPublish[] = [];

  get isConnected(): boolean {
    if (this.client?.connected) return true;
    return Boolean(this.broadcastChannel);
  }

  private ensureBroadcastChannel(): BroadcastChannel | null {
    if (this.broadcastChannel) return this.broadcastChannel;
    if (typeof BroadcastChannel === 'undefined') return null;

    const channel = new BroadcastChannel(SIGNALING_CONFIG.TEST_SIGNALING_CHANNEL);
    channel.onmessage = (event: MessageEvent) => {
      this.handleBroadcastEvent(event.data);
    };
    this.broadcastChannel = channel;
    return channel;
  }

  private handleBroadcastEvent(data: unknown): void {
    if (!isRecord(data) || typeof data.topic !== 'string') return;
    const envelope = parseSignalingEnvelope(data.envelope);
    if (!envelope) return;
    this.routeEnvelope(data.topic, envelope);
  }

  private markUnseen(messageId: string): boolean {
    if (this.seenSet.has(messageId)) return false;
    this.seenSet.add(messageId);
    this.seenQueue.push(messageId);
    if (this.seenQueue.length <= MAX_SEEN_IDS) return true;

    const evicted = this.seenQueue.shift();
    if (evicted) this.seenSet.delete(evicted);
    return true;
  }

  private routeEnvelope(rawTopic: string, envelope: SignalingEnvelopeDto): void {
    const topic = normalizeMqttTopic(rawTopic);
    const handlers = this.topicHandlers.get(topic);
    if (!handlers || handlers.size === 0) return;
    if (!this.markUnseen(envelope.messageId)) return;

    for (const handler of Array.from(handlers)) {
      void invokeTopicHandler(handler, envelope, topic);
    }
  }

  private notifyConnectionListeners(connected: boolean): void {
    for (const listener of Array.from(this.connectionListeners)) {
      listener(connected);
    }
  }

  private resubscribeAllTopics(client: MqttClient): void {
    for (const topic of this.topicHandlers.keys()) {
      client.subscribe(topic, (err) => {
        if (err) console.error(`[MQTT] Subscribe error for "${topic}":`, err);
      });
    }
  }

  private flushPendingPublishes(client: MqttClient): void {
    const queued = this.pendingPublishes.splice(0, this.pendingPublishes.length);
    for (const item of queued) {
      client.publishAsync(item.topic, item.body).catch(() => {});
    }
  }

  connect(): Promise<boolean> {
    const channel = this.ensureBroadcastChannel();
    if (this.client?.connected) return Promise.resolve(true);
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = new Promise<boolean>((resolve) => {
      const randomPart = Math.random().toString(36).slice(2, 9);
      const clientId = `Elfy_${randomPart}_${Date.now()}`;
      const client = mqtt.connect(SIGNALING_CONFIG.MQTT_BROKER_URL, {
        clientId,
        clean: true,
        connectTimeout: 6000,
        reconnectPeriod: 4000,
        keepalive: 60,
      });

      this.client = client;

      client.on('connect', () => {
        this.resubscribeAllTopics(client);
        this.flushPendingPublishes(client);
        this.notifyConnectionListeners(true);
        resolve(true);
      });

      client.on('close', () => {
        this.notifyConnectionListeners(Boolean(this.broadcastChannel));
      });

      client.on('error', (err) => {
        console.warn('[MQTT] Broker warning:', err.message);
        if (channel) resolve(true);
      });

      client.on('message', (topic, message) => {
        const envelope = parseSignalingEnvelope(message);
        if (!envelope) return;
        this.routeEnvelope(topic, envelope);
      });

      if (channel) {
        resolve(true);
        return;
      }

      window.setTimeout(() => {
        resolve(Boolean(this.client?.connected || this.broadcastChannel));
      }, 6500);
    });

    return this.connectPromise;
  }

  async subscribeTopic(rawTopic: string, handler: TopicMessageHandler): Promise<() => void> {
    const topic = normalizeMqttTopic(rawTopic);
    if (!topic) return () => {};

    this.ensureBroadcastChannel();
    void this.connect();

    const existing = this.topicHandlers.get(topic);
    const isNewTopic = !existing;
    const set = existing ?? new Set<TopicMessageHandler>();
    set.add(handler);
    this.topicHandlers.set(topic, set);

    if (isNewTopic && this.client?.connected) {
      this.client.subscribe(topic, (err) => {
        if (err) console.error(`[MQTT] Subscribe error for "${topic}":`, err);
      });
    }

    return () => {
      this.detachTopicHandler(topic, handler);
    };
  }

  private detachTopicHandler(topic: string, handler: TopicMessageHandler): void {
    const set = this.topicHandlers.get(topic);
    if (!set) return;

    set.delete(handler);
    if (set.size > 0) return;

    this.topicHandlers.delete(topic);
    if (this.client?.connected) {
      this.client.unsubscribe(topic);
    }
  }

  async unsubscribeTopic(rawTopic: string): Promise<void> {
    const topic = normalizeMqttTopic(rawTopic);
    if (!topic) return;

    this.topicHandlers.delete(topic);
    if (this.client?.connected) {
      this.client.unsubscribe(topic);
    }
  }

  async publish<T extends SignalingPayload>(
    rawTopic: string,
    envelope: SignalingEnvelopeDto<T>
  ): Promise<boolean> {
    const topic = normalizeMqttTopic(rawTopic);
    if (!topic) return false;

    const channel = this.ensureBroadcastChannel();
    if (channel) {
      channel.postMessage({ topic, envelope });
    }

    const body = JSON.stringify(envelope);
    void this.connect();

    if (this.client?.connected) {
      try {
        await this.client.publishAsync(topic, body);
        return true;
      } catch (err) {
        console.warn(`[MQTT] Publish fallback warning on "${topic}":`, err);
        return Boolean(channel);
      }
    }

    if (this.pendingPublishes.length < MAX_PENDING_PUBLISHES) {
      this.pendingPublishes.push({ topic, body });
    }

    return Boolean(channel);
  }

  onConnectionChange(listener: ConnectionStateListener): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }
}

export const signalingTransport: ISignalingTransport = new MqttSignalingAdapter();
