import { useRef, useState, useCallback } from 'react';
import { useBroker } from './useBroker';

const ICE_SERVERS = [{ urls: 'stun:stun.l.google.com:19302' }];

export const useViewerConnection = () => {
  const broker = useBroker();
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);

  // 1. Accept Incoming Offer & Return Answer
  const acceptOffer = useCallback(async (
    hostReplyTopic: string,
    offerSdp: RTCSessionDescriptionInit
  ) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    pcRef.current = pc;

    // Listen for incoming media track
    pc.ontrack = (event) => {
      if (event.streams && event.streams[0]) {
        setRemoteStream(event.streams[0]);
      }
    };

    // Send ICE candidates back to the host topic
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        broker.dispatchMessage(hostReplyTopic, {
          type: 'candidate',
          data: event.candidate.toJSON(),
        });
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offerSdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // Send Answer back to host
    await broker.dispatchMessage(hostReplyTopic, {
      type: 'answer',
      sdp: answer,
    });
  }, [broker]);

  // 2. Handle ICE Candidates from Host
  const handleCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    if (pcRef.current && pcRef.current.remoteDescription) {
      await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }, []);

  const disconnect = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    setRemoteStream(null);
  }, []);

  return {
    remoteStream,
    acceptOffer,
    handleCandidate,
    disconnect,
  };
};