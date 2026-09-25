import React, { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import styles from './StreamViewerPage.module.css';
import { StreamItem } from '../../types';
import { Header } from '../../components/Header/Header';
import { MultiStreamHub } from '../../components/MultiStreamHub/MultiStreamHub';
import { FullscreenStreamViewer } from '../../components/MultiStreamHub/FullscreenStreamViewer';
import {
  closeStreamWindowTauri,
  isTauri,
  setFullscreenTauri,
  showRegisterWindowTauri,
} from '../../utils/tauri';
import { useProfile } from '../../hooks/useProfile';
import { useHub } from '../../hooks/useHub';

export const StreamViewerPage: React.FC = () => {
  const [searchParams] = useSearchParams();
  const hubIdParam = searchParams.get('hubId') || '';
  const autoStartParam = searchParams.get('autoStart') === 'true';

  const [activeHubSlug, setActiveHubSlug] = useState<string>(hubIdParam);

  const {
    startScreenShare,
    stopScreenShare,
    localStream,
    remoteStream,
    isSharing,
  } = useHub(activeHubSlug);

  // Reacts immediately whenever search parameters change or are passed on window creation
  useEffect(() => {
    if (hubIdParam) {
      setActiveHubSlug(hubIdParam);
    }
  }, [hubIdParam]);

  useEffect(() => {
    if (autoStartParam && !isSharing && activeHubSlug) {
      startScreenShare();
    }
  }, [autoStartParam, isSharing, activeHubSlug, startScreenShare]);

  const { profile } = useProfile();
  const [streams, setStreams] = useState<StreamItem[]>([]);
  const [fullscreenStreamId, setFullscreenStreamId] = useState<string | null>(null);

  // Dynamically attach active local and remote WebRTC streams to the tile grid
  const displayStreams = useMemo(() => {
    let list = [...streams];

    if (localStream) {
      const localItem: StreamItem = {
        id: 'local-screen-share',
        name: `${profile.nickname}'s Screen`,
        tag: 'My Screen (Live)',
        resolution: '1080p',
        fps: 60,
        avatarUrl: profile.avatarUrl,
        isLive: true,
        volume: 100,
        isLocal: true
      };
      list = [localItem, ...list.filter((s) => s.id !== 'local-screen-share')];
    } else {
      list = list.filter((s) => s.id !== 'local-screen-share');
    }

    if (remoteStream) {
      const remoteItem: StreamItem = {
        id: 'remote-peer-stream',
        name: 'Peer Screen',
        tag: 'Live Broadcast',
        resolution: '1080p',
        fps: 60,
        avatarUrl: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=100&auto=format&fit=crop&q=80',
        isLive: true,
        volume: 100,
        isLocal: false
      };
      list = [remoteItem, ...list.filter((s) => s.id !== 'remote-peer-stream')];
    }

    return list;
  }, [streams, localStream, remoteStream, profile]);

  const handleUpdateVolume = (id: string, vol: number) => {
    setStreams((prev) =>
      prev.map((s) => (s.id === id ? { ...s, volume: vol } : s))
    );
  };

  const handleEnterFullscreen = async (streamId: string) => {
    setFullscreenStreamId(streamId);
    await setFullscreenTauri(true);
  };

  const handleExitFullscreen = async () => {
    setFullscreenStreamId(null);
    await setFullscreenTauri(false);
  };

  const handleCloseStream = async () => {
    if (isTauri()) {
      await closeStreamWindowTauri();
    }
  };

  const handleOpenProfileWindow = async () => {
    if (isTauri()) {
      await showRegisterWindowTauri();
    } else {
      window.open('/#/register', '_blank', 'width=580,height=620');
    }
  };

  // Dedicated video-only fullscreen mode
  const fullscreenStream = fullscreenStreamId
    ? displayStreams.find((s) => s.id === fullscreenStreamId) || displayStreams[0]
    : null;

  if (fullscreenStream) {
    const fullscreenMedia = fullscreenStream.isLocal
      ? localStream
      : fullscreenStream.id === 'remote-peer-stream'
      ? remoteStream
      : null;

    return (
      <FullscreenStreamViewer
        stream={fullscreenStream}
        mediaStream={fullscreenMedia}
        onExitFullscreen={handleExitFullscreen}
        onVolumeChange={(vol) => handleUpdateVolume(fullscreenStream.id, vol)}
      />
    );
  }

  return (
    <div className={styles.streamContainer}>
      <Header
        profile={profile}
        activeStreamsCount={displayStreams.length}
        onCloseStream={handleCloseStream}
        onOpenProfile={handleOpenProfileWindow}
        roomTitle={activeHubSlug || 'The Treehouse'}
      />
      <div className={styles.streamViewArea}>
        <MultiStreamHub
          streams={displayStreams}
          profile={profile}
          mediaStream={localStream}
          remoteStream={remoteStream}
          isSharing={isSharing}
          onStartShare={startScreenShare}
          onStopShare={stopScreenShare}
          onUpdateVolume={handleUpdateVolume}
          onToggleFullscreen={handleEnterFullscreen}
        />
      </div>
    </div>
  );
};

export default StreamViewerPage;
