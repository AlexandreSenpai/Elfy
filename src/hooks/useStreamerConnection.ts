import { useCallback, useRef, useState } from 'react';
import { useBroker } from './useBroker';
import { PendingKnock } from '../types/knock';
import { CreatedOffer, FoundICECandidate } from '../types/offer';
import { ICEServers } from '../utils/stun';
import { getGuestInboxTopic } from '../utils/hubTopics';

export const useStreamerConnection = () => {
  const broker = useBroker();
  const stream = useRef<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  // Key by guest inbox topic:
  const peerConnections = useRef<Map<string, RTCPeerConnection>>(new Map());

  const startStream = useCallback(async () => {
    const media = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 60, max: 144 } },
      audio: true
    });
    stream.current = media;
    setLocalStream(media);
    media.getVideoTracks()[0].onended = () => stopStream();
    return media;
  }, []);

  const stopStream = useCallback(async () => {
    stream.current?.getTracks()?.forEach((track) => track.stop());
    stream.current = null;
    setLocalStream(null);
    peerConnections.current.forEach((peer) => peer.close());
    peerConnections.current.clear();
  }, []);

  const createOffer = useCallback(async (acceptedKnock: PendingKnock) => {
    if (!stream.current) {
      console.error("Cannot create offer: local stream is not active.");
      return;
    }

    const guestInbox = getGuestInboxTopic(acceptedKnock.hubTopic, acceptedKnock.peerIdSafe);

    // If a connection for this guest already exists and is active, do not overwrite it!
    const existingPC = peerConnections.current.get(guestInbox);
    if (existingPC && existingPC.connectionState !== 'closed' && existingPC.connectionState !== 'failed') {
      console.warn(`[Streamer] PC for ${guestInbox} already exists in state: ${existingPC.connectionState}. Skipping duplicate offer.`);
      return;
    }

    const peerConnection = new RTCPeerConnection({ iceServers: ICEServers });
    peerConnections.current.set(guestInbox, peerConnection);

    // Attach all tracks to the peer connection
    stream.current.getTracks().forEach((track) => {
      peerConnection.addTrack(track, stream.current!);
    });

    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      broker.dispatchMessage<FoundICECandidate>(guestInbox, {
        type: 'candidate',
        candidate: event.candidate,
      });
    };

    const offer = await peerConnection.createOffer({
      offerToReceiveAudio: true,
      offerToReceiveVideo: true,
    });
    await peerConnection.setLocalDescription(offer);

    // Dispatch directly to the guest's inbox topic
    await broker.dispatchMessage<CreatedOffer>(guestInbox, {
      type: 'offer_created',
      sdp: offer,
    });
  }, [broker]);

  const handleOfferAnswer = useCallback(async (answer: RTCSessionDescriptionInit) => {
    // Apply answer across pending connections waiting for remote answer
    for (const [_, pc] of peerConnections.current.entries()) {
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
      }
    }
  }, []);

  const handleCandidate = useCallback(async (candidate: RTCIceCandidateInit) => {
    for (const [_, pc] of peerConnections.current.entries()) {
      if (pc.remoteDescription) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.warn('[Streamer] Error adding ICE candidate:', e);
        }
      }
    }
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

export default useStreamerConnection;