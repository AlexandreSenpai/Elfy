import { useEffect, useState, useCallback, useRef } from 'react';
import mqtt, { MqttClient } from 'mqtt';

type MessageListener = (topic: string, message: Buffer) => Promise<void> | void;

// Module-level shared client state for the current window
let globalClient: MqttClient | null = null;
let connectionPromise: Promise<MqttClient> | null = null;
const activeListeners = new Set<MessageListener>();
const connectionListeners = new Set<(connected: boolean) => void>();
const subscribedTopics = new Set<string>();

const BROKER_URL = 'wss://broker.emqx.io:8084/mqtt';

const getOrCreateClient = (): Promise<MqttClient> => {
  if (globalClient && globalClient.connected) {
    return Promise.resolve(globalClient);
  }

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = new Promise<MqttClient>((resolve) => {
    const randomId = Math.random().toString(36).substring(2, 9);
    const clientId = `Elfy_Client_${randomId}_${Date.now()}`;

    console.log(`[MQTT] Connecting to broker with clientId: ${clientId}`);
    const client = mqtt.connect(BROKER_URL, {
      clientId,
      clean: true,
      connectTimeout: 10000,
      reconnectPeriod: 3000,
      keepalive: 60,
    });

    client.on('connect', () => {
      console.log('[MQTT] Connected to broker successfully');
      connectionListeners.forEach((fn) => fn(true));
      // Re-subscribe to any previously active topics if reconnected
      subscribedTopics.forEach((t) => {
        client.subscribe(t, (err) => {
          if (err) console.error(`[MQTT] Re-subscription error for ${t}:`, err);
        });
      });
      resolve(client);
    });

    client.on('reconnect', () => {
      console.log('[MQTT] Reconnecting to broker...');
    });

    client.on('close', () => {
      console.log('[MQTT] Connection closed');
      connectionListeners.forEach((fn) => fn(false));
    });

    client.on('error', (err) => {
      console.error('[MQTT] Connection error:', err);
    });

    client.on('message', (topic, message) => {
      activeListeners.forEach(async (listener) => {
        try {
          await listener(topic, message as Buffer);
        } catch (e) {
          console.error('[MQTT] Error in message listener:', e);
        }
      });
    });

    globalClient = client;
  });

  return connectionPromise;
};

export const useBroker = () => {
  const [isConnected, setIsConnected] = useState<boolean>(() => {
    return Boolean(globalClient?.connected);
  });
  const brokerClientRef = useRef<MqttClient | null>(globalClient);

  useEffect(() => {
    let mounted = true;

    const handleConnChange = (status: boolean) => {
      if (mounted) {
        setIsConnected(status);
        brokerClientRef.current = globalClient;
      }
    };

    connectionListeners.add(handleConnChange);

    getOrCreateClient().then((client) => {
      if (mounted) {
        brokerClientRef.current = client;
        setIsConnected(client.connected);
      }
    }).catch(console.error);

    return () => {
      mounted = false;
      connectionListeners.delete(handleConnChange);
    };
  }, []);

  const waitForConnection = useCallback(async (timeoutMs = 8000): Promise<boolean> => {
    if (globalClient?.connected) return true;
    const client = await getOrCreateClient();
    if (client.connected) return true;

    return new Promise((resolve) => {
      const startTime = Date.now();
      const interval = setInterval(() => {
        if (globalClient?.connected) {
          clearInterval(interval);
          resolve(true);
        } else if (Date.now() - startTime > timeoutMs) {
          clearInterval(interval);
          resolve(false);
        }
      }, 100);
    });
  }, []);

  const dispatchMessage = useCallback(async <EventPayload>(
    topic: string,
    payload: EventPayload
  ): Promise<string | undefined> => {
    const ready = await waitForConnection();
    if (!ready || !globalClient) {
      console.error(`[MQTT] Couldn't dispatch message to ${topic}: broker not connected`);
      return;
    }

    try {
      const cleanedTopic = topic.replace(/#/g, '_');
      console.log(`[MQTT Dispatch] -> ${cleanedTopic}:`, payload);
      const res = await globalClient.publishAsync(cleanedTopic, JSON.stringify(payload));
      return String(res?.messageId ?? 'ok');
    } catch (err) {
      console.error(`[MQTT] Couldn't publish message to ${topic}:`, err);
    }
  }, [waitForConnection]);

  const subscribeTo = useCallback(async (topic: string): Promise<void> => {
    const cleanedTopic = topic.replace(/#/g, '_');
    subscribedTopics.add(cleanedTopic);

    const ready = await waitForConnection();
    if (!ready || !globalClient) {
      console.warn(`[MQTT] Cannot subscribe to ${cleanedTopic}: broker not connected yet`);
      return;
    }

    globalClient.subscribe(cleanedTopic, (err) => {
      if (!err) {
        console.log(`[MQTT Subscribed] -> ${cleanedTopic}`);
      } else {
        console.error(`[MQTT Subscription Error] for ${cleanedTopic}:`, err);
      }
    });
  }, [waitForConnection]);

  const unsubscribeFrom = useCallback(async (topic: string): Promise<void> => {
    const cleanedTopic = topic.replace(/#/g, '_');
    subscribedTopics.delete(cleanedTopic);

    if (globalClient?.connected) {
      globalClient.unsubscribe(cleanedTopic, (err) => {
        if (!err) {
          console.log(`[MQTT Unsubscribed] -> ${cleanedTopic}`);
        }
      });
    }
  }, []);

  /**
   * Listen to messages. Callback can accept (topic, message) or just (message).
   * Returns a cleanup function that detaches the listener.
   */
  const listenToMessages = useCallback((
    callback: (message: Buffer, topic?: string) => Promise<void>
  ): (() => void) => {
    const wrapper: MessageListener = async (topic, message) => {
      await callback(message, topic);
    };

    activeListeners.add(wrapper);
    return () => {
      activeListeners.delete(wrapper);
    };
  }, []);

  return {
    brokerClient: brokerClientRef,
    isConnected,
    dispatchMessage,
    subscribeTo,
    unsubscribeFrom,
    listenToMessages
  };
};

export default useBroker;