import React from 'react';
import { useNavigate } from 'react-router-dom';
import styles from './FriendHubsPage.module.css';
import { FriendHubs } from '../../components/FriendHubs/FriendHubs';
import { RoomRole } from '../../domain/dtos';
import { useFriendHubsDiscovery } from '../../hooks/useFriendHubsDiscovery';
import { useProfile } from '../../hooks/useProfile';
import { isHubOwner } from '../../utils/hubTopics';
import { isTauri, openStreamWindowTauri, showRegisterWindowTauri } from '../../utils/tauri';

export const FriendHubsPage: React.FC = () => {
  const navigate = useNavigate();
  const { profile, isLoading: isProfileLoading } = useProfile();
  const {
    hubs,
    isProbing,
    minimizedHub,
    refreshHubsStatus,
    removeFriendHub,
    restoreMinimizedHub,
    disconnectMinimizedHub,
  } = useFriendHubsDiscovery(profile);

  const handleOpenHub = async (hubId: string, autoStart: boolean = false): Promise<void> => {
    const joinedAs: RoomRole = isHubOwner(hubId, profile) ? 'owner' : 'guest';

    if (isTauri()) {
      await openStreamWindowTauri(hubId, autoStart, joinedAs);
      return;
    }

    const query = `hubId=${encodeURIComponent(hubId)}&autoStart=${String(autoStart)}&joinedAs=${joinedAs}`;
    navigate(`/stream?${query}`);
  };

  const handleOpenProfileWindow = async (): Promise<void> => {
    if (isTauri()) {
      await showRegisterWindowTauri();
      return;
    }
    navigate('/register');
  };

  const handleRestoreMinimized = async (): Promise<void> => {
    await restoreMinimizedHub();
    if (!minimizedHub || isTauri()) return;
    const query =
      `hubId=${encodeURIComponent(minimizedHub.hubId)}&autoStart=false&joinedAs=${minimizedHub.role}`;
    navigate(`/stream?${query}`);
  };

  return (
    <div className={styles.companionWrapper}>
      <FriendHubs
        profile={profile}
        isProfileLoading={isProfileLoading}
        hubs={hubs}
        isProbing={isProbing}
        minimizedHub={minimizedHub}
        onOpenHub={handleOpenHub}
        onOpenProfile={handleOpenProfileWindow}
        onRefreshHubs={refreshHubsStatus}
        onRemoveHub={removeFriendHub}
        onRestoreMinimizedHub={handleRestoreMinimized}
        onDisconnectMinimizedHub={disconnectMinimizedHub}
      />
    </div>
  );
};

export default FriendHubsPage;
