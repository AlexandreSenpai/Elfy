import React, { useEffect, useCallback } from 'react';
import styles from './StreamerView.module.css';
import { useStreamerConnection } from '../../../hooks/useStreamerConnection';
import { useHubKnocking } from '../../../hooks/useHubKnocking';
import { useBroker } from '../../../hooks/useBroker';
import { HostKnockAlert } from '../../../components/HostKnockAlert/HostKnockAlert';
import { StreamPlayer } from '../../../components/StreamPlayer/StreamPlayer';
import { UserProfile, PendingKnock } from '../../../types';
import { normalizeHubTopic } from '../../../utils/hubTopics';

interface StreamerViewProps {
  hubTopic: string;
  profile: UserProfile;
  autoStart?: boolean;
}

export const StreamerView: React.FC<StreamerViewProps> = ({
  hubTopic,
  profile,
  autoStart
}) => {
  const broker = useBroker();
  const normalizedHub = normalizeHubTopic(hubTopic);

  const {
    localStream,
    isStreaming,
    startStream,
    stopStream,
    createOffer,
    handleOfferAnswer,
    handleCandidate
  } = useStreamerConnection();

  const {
    pendingKnocks,
    acceptKnock,
    rejectKnock
  } = useHubKnocking(normalizedHub, profile, 'owner');

  const handleKnockingAccept = useCallback(async (knock: PendingKnock) => {
    // 1. Remove from pendingKnocks state first to prevent duplicate clicks/renders
    await acceptKnock(knock);
    // 2. Dispatch offer
    await createOffer(knock);
  }, [acceptKnock, createOffer]);

  // Handle incoming guest answers and ICE candidates
  useEffect(() => {
    if (!normalizedHub) return;
    broker.subscribeTo(normalizedHub);

    const unlisten = broker.listenToMessages(async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());
        if (data.type === 'answer' && data.sdp) {
          await handleOfferAnswer(data.sdp);
        } else if (data.type === 'candidate' && (data.candidate || data.data)) {
          await handleCandidate(data.candidate || data.data);
        }
      } catch (err) {
        console.error('[StreamerView] Error processing signaling message:', err);
      }
    });

    return () => {
      unlisten();
    };
  }, [broker, normalizedHub, handleOfferAnswer, handleCandidate]);

  // Auto-start stream if requested
  useEffect(() => {
    if (autoStart && !isStreaming) {
      startStream().catch(console.error);
    }
  }, [autoStart, isStreaming, startStream]);

  return (
    <div className={styles.streamerContainer}>
      <HostKnockAlert
        pendingKnocks={pendingKnocks}
        onAccept={handleKnockingAccept}
        onReject={rejectKnock}
      />

      <div className={styles.playerArea}>
        <StreamPlayer
          mediaStream={localStream}
          isLocal={true}
          streamerName={profile.nickname}
          streamerAvatar={profile.avatarUrl}
          isLive={isStreaming}
          controls={
            isStreaming ? (
              <button
                className={styles.stopBtn}
                onClick={stopStream}
                type="button"
                title="Stop Sharing"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                  stop_screen_share
                </span>
                <span>Stop Sharing</span>
              </button>
            ) : null
          }
          emptyState={
            <div className={styles.startBroadcastBox}>
              <div className={styles.iconCircle}>
                <span className="material-symbols-outlined" style={{ fontSize: '42px', color: 'var(--primary)' }}>
                  screen_share
                </span>
              </div>
              <h3>Ready to Broadcast</h3>
              <p>Select a screen or window to start streaming to viewers in {normalizedHub || 'your hub'}.</p>
              <button
                className={styles.startBtn}
                onClick={() => startStream()}
                type="button"
              >
                <span className="material-symbols-outlined" style={{ fontSize: '20px' }}>
                  screen_share
                </span>
                Start Sharing Screen
              </button>
            </div>
          }
        />
      </div>
    </div>
  );
};

export default StreamerView;
