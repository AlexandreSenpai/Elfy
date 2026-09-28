import React, { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import styles from './StreamViewerPage.module.css';
import { Header } from '../../components/Header/Header';
import { closeStreamWindowTauri, isTauri, showRegisterWindowTauri } from '../../utils/tauri';
import { useProfile } from '../../hooks/useProfile';
import { isHubOwner } from '../../utils/hubTopics';
import { listen } from '@tauri-apps/api/event';
import { StreamerView } from './components/StreamerView';
import { ViewerView } from './components/ViewerView';

export const StreamViewerPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { profile } = useProfile();

  const urlHubId = searchParams.get('hubId') || '';
  const urlAutoStart = searchParams.get('autoStart') === 'true';
  const urlJoinedAs = searchParams.get('joinedAs') as 'owner' | 'guest' | null;

  const [activeHubSlug, setActiveHubSlug] = useState<string>(urlHubId);
  const [autoStart, setAutoStart] = useState<boolean>(urlAutoStart);
  const [joinedAs, setJoinedAs] = useState<'owner' | 'guest'>(() => {
    if (urlJoinedAs) return urlJoinedAs;
    if (urlHubId && isHubOwner(urlHubId, profile)) return 'owner';
    return 'guest';
  });

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{
      hubId: string;
      autoStart?: boolean;
      joinedAs?: 'owner' | 'guest';
    }>('request-start-stream', (event) => {
      const targetHub = event.payload.hubId || '';
      setActiveHubSlug(targetHub);
      setAutoStart(Boolean(event.payload.autoStart));

      if (event.payload.joinedAs) {
        setJoinedAs(event.payload.joinedAs);
      } else if (targetHub && isHubOwner(targetHub, profile)) {
        setJoinedAs('owner');
      } else {
        setJoinedAs('guest');
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [profile]);

  const handleCloseStream = async () => {
    if (isTauri()) {
      await closeStreamWindowTauri();
    } else {
      window.close();
    }
  };

  const handleOpenProfileWindow = async () => {
    if (isTauri()) {
      await showRegisterWindowTauri();
    } else {
      window.open('/#/register', '_blank', 'width=580,height=620');
    }
  };

  return (
    <div className={styles.streamContainer}>
      <Header
        profile={profile}
        activeStreamsCount={1}
        onCloseStream={handleCloseStream}
        onOpenProfile={handleOpenProfileWindow}
        roomTitle={activeHubSlug || 'Elfy Hub'}
      />
      {joinedAs === 'owner' ? (
        <StreamerView
          hubTopic={activeHubSlug}
          profile={profile}
          autoStart={autoStart}
        />
      ) : (
        <ViewerView
          hubTopic={activeHubSlug}
          profile={profile}
        />
      )}
    </div>
  );
};

export default StreamViewerPage;
