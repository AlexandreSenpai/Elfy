import React, { useEffect } from 'react';
import styles from './ViewerView.module.css';
import { useViewerConnection } from '../../../hooks/useViewerConnection';
import { useHubKnocking } from '../../../hooks/useHubKnocking';
import { useBroker } from '../../../hooks/useBroker';
import { GuestKnockGate } from '../../../components/GuestKnockGate/GuestKnockGate';
import { StreamPlayer } from '../../../components/StreamPlayer/StreamPlayer';
import { UserProfile } from '../../../types';
import {
  normalizeHubTopic,
  toSafePeerTag,
  getGuestInboxTopic
} from '../../../utils/hubTopics';

interface ViewerViewProps {
  hubTopic: string;
  profile: UserProfile;
}

export const ViewerView: React.FC<ViewerViewProps> = ({
  hubTopic,
  profile
}) => {
  const broker = useBroker();
  const normalizedHub = normalizeHubTopic(hubTopic);

  const {
    remoteStream,
    acceptOffer,
    handleCandidate,
    disconnect
  } = useViewerConnection();

  const {
    hostInfo,
    knockStatus,
    entranceAccepted,
    requestHubEntrance,
    cancelKnock
  } = useHubKnocking(normalizedHub, profile, 'guest');

  // Only knock when a non-empty normalized hub topic exists
  useEffect(() => {
    if (normalizedHub && knockStatus === 'idle') {
      requestHubEntrance();
    }
  }, [normalizedHub, knockStatus, requestHubEntrance]);

  // Handle incoming offer and ICE candidates from host
  useEffect(() => {
    if (!normalizedHub) return;

    broker.subscribeTo(normalizedHub);

    const guestTagSafe = toSafePeerTag(profile.nickname, profile.peerTag);
    const guestInbox = getGuestInboxTopic(normalizedHub, guestTagSafe);
    broker.subscribeTo(guestInbox);

    const unlisten = broker.listenToMessages(async (message: Buffer, topic?: string) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'offer_created' && data.sdp) {
          await acceptOffer(topic || normalizedHub, data.sdp);
        } else if (data.type === 'candidate' && (data.candidate || data.data)) {
          await handleCandidate(data.candidate || data.data);
        }
      } catch (err) {
        console.error('[ViewerView] Error processing signaling message:', err);
      }
    });

    return () => {
      unlisten();
      disconnect();
    };
  }, [broker, normalizedHub, profile, acceptOffer, handleCandidate, disconnect]);

  // If entrance is not approved yet, display the guest knock gate
  if (!entranceAccepted) {
    return (
      <div className={styles.gateArea}>
        <GuestKnockGate
          hubId={normalizedHub}
          hostName={hostInfo.displayName}
          status={knockStatus}
          onRetry={requestHubEntrance}
          onCancel={cancelKnock}
        />
      </div>
    );
  }

  // Once approved, display the player visualization
  return (
    <div className={styles.viewerContainer}>
      <StreamPlayer
        mediaStream={remoteStream}
        isLocal={false}
        streamerName={hostInfo.displayName || 'Host'}
        isLive={Boolean(remoteStream)}
        emptyState={
          <div className={styles.waitingBox}>
            <div className={styles.iconCircle}>
              <span className="material-symbols-outlined" style={{ fontSize: '42px', color: '#10b981' }}>
                hourglass_top
              </span>
            </div>
            <h3>Entrance Approved</h3>
            <p>{hostInfo.displayName} accepted your knock. Waiting for stream tracks...</p>
          </div>
        }
      />
    </div>
  );
};

export default ViewerView;
