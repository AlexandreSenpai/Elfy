import { useRef, useState, useCallback, useEffect } from 'react';
import { useBroker } from './useBroker';
import { UserProfile } from '../types';

interface SignalPayload {
  senderId: string;
  targetId?: string;
  type: 'join' | 'offer' | 'answer' | 'candidate';
  data?: any;
}

type KnockEvent = {
  type: "knock",
  peerTag: string,
  displayName: string,
  timestamp: number
}

export const useHub = (hubId: string, profile: UserProfile) => {
  const currentUserPeerTag = `${profile.nickname}${profile.peerTag}`;
  const [currentHubId, setCurrentHubId] = useState<string>(hubId);
  const [entranceAccepted, setEntranceAccepted] = useState<boolean>(false);

  // const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  // const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  // const [connectionStatus, setConnectionStatus] = useState<string>('disconnected');
  // const [isSharing, setIsSharing] = useState<boolean>(false);
  const broker = useBroker();

  // Stable random ID for this session
  // const remotePeerIdRef = useRef<string | null>(null);
  // const pcRef = useRef<RTCPeerConnection | null>(null);
  // const localStreamRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    if (hubId) {
      setCurrentHubId(hubId);
    }
  }, [hubId]);

  const knock = async () => {
    if (!currentHubId) {
      console.error(`There's no hub available for knocking.`);
      return;
    }

    await broker.dispatchMessage<KnockEvent>(`${currentHubId}/knock`, {
      type: "knock",
      peerTag: profile.peerTag,
      displayName: profile.nickname,
      timestamp: new Date().getTime()
    });
  }

  const requestHubEntrance = async () => {
    // knocking
    if(!currentHubId || !profile) {
      console.error(`There's no Hub or Profile Available: ${currentHubId} - ${JSON.stringify(profile)}`)
      return;
    }

    await broker.subscribeTo(`${currentHubId}/peer/${currentUserPeerTag}`);
    await knock();
    
    const listenToKnockAnswer = async (message: Buffer<ArrayBufferLike>): Promise<void> => {
      const answer = JSON.parse(message.toString());
      if (answer.type === 'answer_accepted') {
        console.log("Owner Has Accepted!");
        setEntranceAccepted(true);
      } else {
        console.log("Owner Has Rejected :(")
        setEntranceAccepted(false);
      }
    }

    broker.listenToMessages(listenToKnockAnswer);
  }

  
  // // 1. Initialize or retrieve WebRTC Peer Connection
  // const getOrCreatePeerConnection = useCallback(() => {
  //   if (pcRef.current) return pcRef.current;

  //   const pc = new RTCPeerConnection({
  //     iceServers: [
  //       { urls: 'stun:stun.l.google.com:19302' },
  //       { urls: 'stun:stun1.l.google.com:19302' },
  //     ],
  //   });

  //   // When your PC discovers one of its network routes:
  //   pc.onicecandidate = (event) => {
  //     if (event.candidate) {
  //       broadcastSignal({
  //         senderId: peerIdRef.current,
  //         targetId: remotePeerIdRef.current || undefined,
  //         type: 'candidate',
  //         data: event.candidate.toJSON(),
  //       });
  //     }
  //   };

  //   // When the friend's video track arrives:
  //   pc.ontrack = (event) => {
  //     if (event.streams && event.streams[0]) {
  //       setRemoteStream(event.streams[0]);
  //     }
  //   };

  //   pc.onconnectionstatechange = () => {
  //     setConnectionStatus(pc.connectionState);
  //   };

  //   // Attach existing local tracks if available
  //   if (localStreamRef.current) {
  //     localStreamRef.current.getTracks().forEach((track) => {
  //       pc.addTrack(track, localStreamRef.current!);
  //     });
  //   }

  //   pcRef.current = pc;
  //   return pc;
  // }, [broadcastSignal]);

  return {
    requestHubEntrance,
    entranceAccepted
  };
};