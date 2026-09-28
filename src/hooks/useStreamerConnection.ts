import { useCallback, useRef, useState } from 'react';
import { useBroker } from './useBroker';
import { PendingKnock } from '../types/knock';
import { CreatedOffer, FoundICECandidate } from '../types/offer';
import { ICEServers } from '../utils/stun';

export const useStreamerConnection = () => {
  const broker = useBroker();

  const stream = useRef<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());

  const startStream = useCallback(async () => {
    stream.current = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 144 }},
      audio: true
    });
    setLocalStream(stream.current);
    stream.current.getVideoTracks()[0].onended = () => stopStream();
    return stream.current;
  }, [])

  const stopStream = useCallback(async () => {
    stream.current?.getTracks?.()?.forEach(track => track.stop());
    stream.current = null;
    setLocalStream(null);
    peerConnections.current.forEach((peer) => peer.close());
    peerConnections.current.clear();
  }, []);

  const createOffer = useCallback(async (acceptedKnock: PendingKnock) => {
    if (!stream.current) {
      console.error("Could't create offer because stream isn't startd properly.");
      return;
    }

    const peerConnection = new RTCPeerConnection({ iceServers: ICEServers });
    peerConnections.current.set(acceptedKnock.hubTopic, peerConnection);

    stream.current.getTracks().forEach(track => {
      peerConnection.addTrack(track, stream.current!);
    });

    peerConnection.onicecandidate = (event) => {
      if(!event.candidate) return;
      broker.dispatchMessage<FoundICECandidate>(acceptedKnock.hubTopic, {
        type: 'candidate',
        candidate: event.candidate
      });
    }

    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true
    });
    await peerConnection.setLocalDescription(offer);

    await broker.dispatchMessage<CreatedOffer>(acceptedKnock.hubTopic, {
      type: 'offer_created',
      sdp: offer
    });
  }, [broker]);

  const handleOfferAnswer = useCallback(async (hubTopic: string, answer: RTCSessionDescriptionInit) => {
    if(!peerConnections.current.has(hubTopic)) return;
    const peerConnection = peerConnections.current.get(hubTopic);
    if(peerConnection?.signalingState !== 'have-local-offer') return;
    peerConnection?.setRemoteDescription(new RTCSessionDescription(answer));
  }, []);

  const handleCandidate = useCallback(async (hubTopic: string, candidate: RTCIceCandidate) => {
    if(peerConnections.current.has(hubTopic)) return;
    const peerConnection = peerConnections.current.get(hubTopic);
    await peerConnection?.addIceCandidate(new RTCIceCandidate(candidate));
  }, []);

  return {
    createOffer,
    startStream,
    stopStream,
    handleOfferAnswer,
    handleCandidate,
    localStream,
    isStreaming: Boolean(localStream)
  };
};