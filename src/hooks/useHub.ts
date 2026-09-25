import { useEffect, useRef, useState, useCallback } from 'react';
import mqtt, { MqttClient } from 'mqtt';

interface SignalPayload {
  senderId: string;
  targetId?: string;
  type: 'join' | 'offer' | 'answer' | 'candidate';
  data?: any;
}

export const useHub = (roomSlug: string) => {
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<string>('disconnected');
  const [isSharing, setIsSharing] = useState<boolean>(false);

  // Stable random ID for this session
  const peerIdRef = useRef<string>(Math.random().toString(36).substring(2, 9));
  const remotePeerIdRef = useRef<string | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const mqttClientRef = useRef<MqttClient | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const iceCandidateQueueRef = useRef<RTCIceCandidateInit[]>([]);
  const isSettingRemoteDescriptionRef = useRef<boolean>(false);

  // Helper to publish over the public relay
  const broadcastSignal = useCallback((payload: SignalPayload) => {
    if (mqttClientRef.current?.connected && roomSlug) {
      const topic = `elfy/hub/${roomSlug.trim()}`;
      mqttClientRef.current.publish(topic, JSON.stringify(payload));
    }
  }, [roomSlug]);

  // Process any queued ICE candidates once remote description is set
  const processQueuedIceCandidates = async (pc: RTCPeerConnection) => {
    while (iceCandidateQueueRef.current.length > 0) {
      const candidateInit = iceCandidateQueueRef.current.shift();
      if (candidateInit) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidateInit));
        } catch (err) {
          console.warn('[WebRTC] Error adding queued ICE candidate:', err);
        }
      }
    }
  };

  // 1. Initialize or retrieve WebRTC Peer Connection
  const getOrCreatePeerConnection = useCallback(() => {
    if (pcRef.current) return pcRef.current;

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
      ],
    });

    // When your PC discovers one of its network routes:
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        broadcastSignal({
          senderId: peerIdRef.current,
          targetId: remotePeerIdRef.current || undefined,
          type: 'candidate',
          data: event.candidate.toJSON(),
        });
      }
    };

    // When the friend's video track arrives:
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    pc.onconnectionstatechange = () => {
      setConnectionStatus(pc.connectionState);
    };

    // Attach existing local tracks if available
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current!);
      });
    }

    pcRef.current = pc;
    return pc;
  }, [broadcastSignal]);

  // Stop screen sharing cleanly
  const stopScreenShare = useCallback(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {}
      });
      localStreamRef.current = null;
    }
    setLocalStream(null);
    setIsSharing(false);

    if (pcRef.current) {
      pcRef.current.getSenders().forEach((sender) => {
        try {
          pcRef.current?.removeTrack(sender);
        } catch {}
      });
    }
  }, []);

  // 2. Connect to the Outbound Relay Broker (Only re-connect when roomSlug changes)
  useEffect(() => {
    if (!roomSlug) return;

    const topic = `elfy/hub/${roomSlug.trim()}`;
    const clientId = `elfy_${peerIdRef.current}_${Math.floor(Math.random() * 1000)}`;

    // Public broker reachable over WSS
    const client = mqtt.connect('wss://broker.emqx.io:8084/mqtt', { clientId });
    mqttClientRef.current = client;

    client.on('connect', () => {
      client.subscribe(topic, (err) => {
        if (!err) {
          // Announce that we entered the room
          broadcastSignal({
            senderId: peerIdRef.current,
            type: 'join',
          });
        }
      });
    });

    client.on('message', async (_, message) => {
      try {
        const signal: SignalPayload = JSON.parse(message.toString());

        // Ignore messages sent by ourselves
        if (signal.senderId === peerIdRef.current) return;

        // If message is targeted to a specific peer, ignore if not for us
        if (signal.targetId && signal.targetId !== peerIdRef.current) {
          return;
        }

        // Store peer ID of the sender as our remote peer
        remotePeerIdRef.current = signal.senderId;

        const pc = getOrCreatePeerConnection();

        switch (signal.type) {
          // A friend clicked "Join" -> If we have a screen stream and we're stable, send them an targeted Offer
          case 'join': {
            if (localStreamRef.current && pc.signalingState === 'stable') {
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              broadcastSignal({
                senderId: peerIdRef.current,
                targetId: signal.senderId,
                type: 'offer',
                data: offer,
              });
            }
            break;
          }

          // Friend sent an Offer -> Accept it and reply with an Answer
          case 'offer': {
            if (!signal.data) return;

            // Handle glare: if we are in have-local-offer, polite peer yields if senderId is smaller
            if (pc.signalingState !== 'stable') {
              if (peerIdRef.current > signal.senderId) {
                // Yield by rolling back our local offer
                await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
              } else {
                console.warn('[WebRTC] Glare detected; ignoring competing offer from lower peer ID');
                return;
              }
            }

            isSettingRemoteDescriptionRef.current = true;
            await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
            isSettingRemoteDescriptionRef.current = false;

            // Flush any ICE candidates that arrived before offer was set
            await processQueuedIceCandidates(pc);

            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            broadcastSignal({
              senderId: peerIdRef.current,
              targetId: signal.senderId,
              type: 'answer',
              data: answer,
            });
            break;
          }

          // Friend sent an Answer -> Finalize the local contract
          case 'answer': {
            if (!signal.data) return;

            // An answer can ONLY be set when we have a pending local offer
            if (pc.signalingState !== 'have-local-offer') {
              console.warn(
                `[WebRTC] Ignoring remote answer: connection is in "${pc.signalingState}", expected "have-local-offer"`
              );
              return;
            }

            isSettingRemoteDescriptionRef.current = true;
            await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
            isSettingRemoteDescriptionRef.current = false;

            // Flush any ICE candidates that arrived before answer was set
            await processQueuedIceCandidates(pc);
            break;
          }

          // Friend found a network route -> Add it or queue if remote description isn't set yet
          case 'candidate': {
            if (!signal.data) return;

            // In WebRTC, candidates require remoteDescription to be populated
            if (!pc.remoteDescription || !pc.remoteDescription.type || isSettingRemoteDescriptionRef.current) {
              iceCandidateQueueRef.current.push(signal.data);
            } else {
              try {
                await pc.addIceCandidate(new RTCIceCandidate(signal.data));
              } catch (candidateErr) {
                console.warn('[WebRTC] addIceCandidate error:', candidateErr);
              }
            }
            break;
          }
        }
      } catch (err) {
        console.error('Error processing signaling message:', err);
      }
    });

    return () => {
      client.end();
      if (pcRef.current) {
        pcRef.current.close();
        pcRef.current = null;
      }
      iceCandidateQueueRef.current = [];
    };
  }, [roomSlug, broadcastSignal, getOrCreatePeerConnection]);

  // 3. Action: Start Screen Sharing
  const startScreenShare = async () => {
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 60, max: 60 } },
        audio: true,
      });

      localStreamRef.current = stream;
      setLocalStream(stream);

      const pc = getOrCreatePeerConnection();

      // Remove any prior tracks
      pc.getSenders().forEach((sender) => {
        try {
          pc.removeTrack(sender);
        } catch {}
      });

      // Attach new video and audio tracks
      stream.getTracks().forEach((track) => {
        pc.addTrack(track, stream);
        track.onended = () => {
          stopScreenShare();
        };
      });

      setIsSharing(true);

      // Only create offer if in stable state
      if (pc.signalingState === 'stable') {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        broadcastSignal({
          senderId: peerIdRef.current,
          targetId: remotePeerIdRef.current || undefined,
          type: 'offer',
          data: offer,
        });
      }
    } catch (err) {
      console.error('Failed to capture screen:', err);
    }
  };

  return {
    localStream,
    remoteStream,
    connectionStatus,
    startScreenShare,
    stopScreenShare,
    isSharing
  };
};