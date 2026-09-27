import { useEffect, useRef, useState, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';

interface SignalPayload {
  senderId: string;
  targetId?: string;
  type: 'join' | 'offer' | 'answer' | 'candidate';
  data?: any;
}

export const useBroker = () => {
	const brokerClient = useRef<MqttClient | null>(null);
	const [isConnected, setIsConnected] = useState<boolean>(false);

	const createMQTTConnection = useCallback(async () => {
		if (brokerClient.current !== null) {
			return;
		}
		const client = mqtt.connect(
			'wss://broker.emqx.io:8084/mqtt', 
			{ clientId: `Test_Client_${Math.random() * 23}` }
		);
		brokerClient.current = client;
	}, []);

  useEffect(() => {
    if(brokerClient.current !== null) return;
    createMQTTConnection();
  }, [brokerClient])

  useEffect(() => {
    if (brokerClient.current === null) {
			setIsConnected(false);
			return;
    }

    setIsConnected(brokerClient.current.connected)
  }, [brokerClient])

  const dispatchMessage = async<EventPayload>(topic: string, payload: EventPayload): Promise<string | undefined> => {
    if (brokerClient.current === null || !brokerClient.current.connected) {
			console.error("Couldnt dispatch message because broker isn't connected.");
			return;
    }

    try {
      const cleanedTopic = topic.replace('#', '_');
      console.log(cleanedTopic, JSON.stringify(payload))
			const published = await brokerClient.current.publishAsync(cleanedTopic, JSON.stringify(payload));
			return String(published?.messageId)
    } catch (err) {
			console.error(`Couldn't publish message to ${topic} due: ${err}`);
    }
  };

  const subscribeTo = async (topic: string): Promise<void> => {
    brokerClient.current?.subscribe(topic.replace("#", "_"), (err) => {
      if (!err) {
        console.log('Successfully subscribed to ' + topic);
      }
    });
  }

	const listenToMessages = async (callback: (message: Buffer<ArrayBufferLike>) => Promise<void>): Promise<void> => {
		brokerClient.current?.on('message', (_, message) => callback(message));
	}

  return {
    brokerClient,
    isConnected,
    dispatchMessage,
		listenToMessages,
    subscribeTo
  };
};