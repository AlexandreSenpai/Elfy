import React, { useState } from 'react';
import styles from './FriendHubsPage.module.css';
import { INITIAL_FRIEND_HUBS } from '../../data/mockData';
import { FriendHubs } from '../../components/FriendHubs/FriendHubs';
import {
  isTauri,
  openStreamWindowTauri,
  showRegisterWindowTauri
} from '../../utils/tauri';
import { useProfile } from '../../hooks/useProfile';

interface FriendHubsPageProps {}

export const FriendHubsPage: React.FC<FriendHubsPageProps> = () => {
  const { profile } = useProfile();
  const [isSharing, setIsSharing] = useState(false);

  const handleOpenHub = async (hubId: string, autoStart: boolean = false) => {
    if (isTauri()) {
      await openStreamWindowTauri(hubId, autoStart);
    }
  };

  const handleOpenProfileWindow = async () => {
    if (isTauri()) {
      await showRegisterWindowTauri();
    } else {
      window.open('/#/register', '_blank', 'width=580,height=620');
    }
  };

  const handleStopShare = () => {
    setIsSharing(false);
  };

  return (
    <div className={styles.companionWrapper}>
      <FriendHubs
        profile={profile}
        hubs={INITIAL_FRIEND_HUBS}
        isSharing={isSharing}
        onOpenHub={handleOpenHub}
        onOpenProfile={handleOpenProfileWindow}
        onStopShare={handleStopShare}
      />
    </div>
  );
};

export default FriendHubsPage;
