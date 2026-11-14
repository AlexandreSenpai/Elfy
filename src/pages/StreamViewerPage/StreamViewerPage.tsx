import React, { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useNavigate, useSearchParams } from 'react-router-dom';
import styles from './StreamViewerPage.module.css';
import { ChooseNickname } from '../../components/ChooseNickname/ChooseNickname';
import { ConnectionFailureBanner } from '../../components/ConnectionFailureBanner/ConnectionFailureBanner';
import { GuestKnockGate } from '../../components/GuestKnockGate/GuestKnockGate';
import { Header } from '../../components/Header/Header';
import { HostKnockAlert } from '../../components/HostKnockAlert/HostKnockAlert';
import { MultiStreamHub } from '../../components/MultiStreamHub/MultiStreamHub';
import { ELFY_MASCOT_ICON } from '../../data/mockData';
import { RoomRole } from '../../domain/dtos';
import { useProfile } from '../../hooks/useProfile';
import { useRoomSession } from '../../hooks/useRoomSession';
import { isHubOwner, normalizeHubTopic } from '../../utils/hubTopics';
import {
  closeStreamWindowTauri,
  isTauri,
  isWindowMinimizedTauri,
  showRegisterWindowTauri,
} from '../../utils/tauri';

interface StreamLaunchEventPayload {
  hubId: string;
  autoStart?: boolean;
  joinedAs?: RoomRole;
}

const parseRoomRole = (value: string | null): RoomRole | null => {
  if (value === 'owner' || value === 'guest') return value;
  return null;
};

export const StreamViewerPage: React.FC = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const {
    profile,
    isLoading: isProfileLoading,
    isRegistered,
    telemetryConsent,
    saveProfile,
    setTelemetryConsent,
  } = useProfile();

  const urlHubId = searchParams.get('hubId') || '';
  const urlAutoStart = searchParams.get('autoStart') === 'true';
  const urlJoinedAs = parseRoomRole(searchParams.get('joinedAs'));

  const [overrideHubSlug, setOverrideHubSlug] = useState<string | null>(null);
  const [overrideAutoStart, setOverrideAutoStart] = useState<boolean | null>(null);
  const [overrideJoinedAs, setOverrideJoinedAs] = useState<RoomRole | null>(null);
  const [isPersonaModalOpen, setIsPersonaModalOpen] = useState(false);

  useEffect(() => {
    setOverrideHubSlug(null);
    setOverrideAutoStart(null);
    setOverrideJoinedAs(null);
  }, [urlHubId, urlAutoStart, urlJoinedAs]);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let unlisten: (() => void) | undefined;

    listen<StreamLaunchEventPayload>('request-start-stream', (event) => {
      if (!active) return;
      const targetHub = event.payload.hubId || '';
      const targetNormalized = normalizeHubTopic(targetHub);
      const currentNormalized = normalizeHubTopic(sessionActionsRef.current.hubId);
      const isSameActiveHub =
        !sessionActionsRef.current.hasLeftRoom &&
        targetNormalized.length > 0 &&
        targetNormalized === currentNormalized &&
        (sessionActionsRef.current.role === 'owner' ||
          sessionActionsRef.current.entranceAccepted ||
          sessionActionsRef.current.knockStatus === 'knocking');

      if (isSameActiveHub) {
        if (sessionActionsRef.current.isMinimized) {
          void sessionActionsRef.current.restoreHub();
        }
        if (Boolean(event.payload.autoStart) && !sessionActionsRef.current.isSharing) {
          void sessionActionsRef.current.startSharing();
        }
        return;
      }

      const urlNormalized = normalizeHubTopic(sessionActionsRef.current.urlHubId);
      setOverrideHubSlug(targetNormalized && targetNormalized === urlNormalized ? null : targetHub);
      setOverrideAutoStart(Boolean(event.payload.autoStart));
      setOverrideJoinedAs(event.payload.joinedAs ?? null);
      sessionActionsRef.current.rejoinRoom();
      if (sessionActionsRef.current.isMinimized) {
        void sessionActionsRef.current.restoreHub();
      }
    })
      .then((fn) => {
        if (!active) {
          fn();
          return;
        }
        unlisten = fn;
      })
      .catch(() => {});

    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let checkTimer: number | null = null;
    let unlistenResized: (() => void) | undefined;

    const scheduleRestoreCheck = (): void => {
      if (!active || !sessionActionsRef.current.isMinimized) return;
      if (checkTimer !== null) {
        window.clearTimeout(checkTimer);
      }
      checkTimer = window.setTimeout(async () => {
        if (!active || !sessionActionsRef.current.isMinimized) return;
        const minimized = await isWindowMinimizedTauri();
        if (!active || minimized || !sessionActionsRef.current.isMinimized) return;
        void sessionActionsRef.current.restoreHub();
      }, 150);
    };

    getCurrentWindow()
      .onResized(() => {
        scheduleRestoreCheck();
      })
      .then((fn) => {
        if (!active) {
          fn();
          return;
        }
        unlistenResized = fn;
      })
      .catch(() => {});

    window.addEventListener('focus', scheduleRestoreCheck);

    return () => {
      active = false;
      if (checkTimer !== null) {
        window.clearTimeout(checkTimer);
      }
      window.removeEventListener('focus', scheduleRestoreCheck);
      unlistenResized?.();
    };
  }, []);

  const activeHubSlug = overrideHubSlug ?? urlHubId;
  const activeAutoStart = overrideAutoStart ?? urlAutoStart;
  const activeRole: RoomRole | undefined =
    overrideJoinedAs ??
    urlJoinedAs ??
    (activeHubSlug && !isProfileLoading ? (isHubOwner(activeHubSlug, profile) ? 'owner' : 'guest') : undefined);

  const session = useRoomSession({
    hubId: activeHubSlug,
    profile,
    role: activeRole,
    autoStart: activeAutoStart,
    isProfileLoading,
  });

  const sessionActionsRef = useRef({
    urlHubId,
    hubId: session.hubId,
    role: session.role,
    knockStatus: session.knockStatus,
    entranceAccepted: session.entranceAccepted,
    isSharing: session.isSharing,
    hasLeftRoom: session.hasLeftRoom,
    isMinimized: session.isMinimized,
    rejoinRoom: session.rejoinRoom,
    restoreHub: session.restoreHub,
    startSharing: session.startSharing,
  });
  sessionActionsRef.current = {
    urlHubId,
    hubId: session.hubId,
    role: session.role,
    knockStatus: session.knockStatus,
    entranceAccepted: session.entranceAccepted,
    isSharing: session.isSharing,
    hasLeftRoom: session.hasLeftRoom,
    isMinimized: session.isMinimized,
    rejoinRoom: session.rejoinRoom,
    restoreHub: session.restoreHub,
    startSharing: session.startSharing,
  };

  const handleBackToFriendHubs = async (): Promise<void> => {
    if (isTauri()) {
      await closeStreamWindowTauri();
      return;
    }
    navigate('/');
  };

  const handleLeaveRoom = async (): Promise<void> => {
    await session.leaveRoom();
  };

  const handleCloseWindow = async (): Promise<void> => {
    await session.leaveRoom();
    await handleBackToFriendHubs();
  };

  const handleCancelKnock = async (): Promise<void> => {
    session.cancelKnock();
    await session.leaveRoom();
    await handleBackToFriendHubs();
  };

  const handleOpenProfile = async (): Promise<void> => {
    if (isTauri()) {
      await showRegisterWindowTauri();
      return;
    }
    setIsPersonaModalOpen(true);
  };

  const renderMainContent = () => {
    if (isProfileLoading) {
      return (
        <div className={styles.streamViewArea}>
          <div className={styles.statusBox}>
            <h3>Loading Watch Room...</h3>
            <p>Preparing your machine-locked persona and P2P session.</p>
          </div>
        </div>
      );
    }

    if (!activeHubSlug) {
      return (
        <div className={styles.streamViewArea}>
          <div className={styles.statusBox}>
            <h3>No Hub Selected</h3>
            <p>Pick a Friend Hub or enter a hub code to join or host a watch room.</p>
            <button
              className={styles.primaryActionBtn}
              onClick={() => void handleBackToFriendHubs()}
              type="button"
            >
              Back to Friend Hubs
            </button>
          </div>
        </div>
      );
    }

    if (session.hasLeftRoom) {
      return (
        <div className={styles.streamViewArea}>
          <div className={styles.leftHubCard}>
            <div className={styles.leftHubMascotWrap}>
              <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" className={styles.leftHubMascotImg} />
            </div>
            <h3>You left {session.hubId}</h3>
            <p>Your screen share and peer connections have been closed cleanly.</p>
            <div className={styles.leftHubActions}>
              <button className={styles.primaryActionBtn} onClick={session.rejoinRoom} type="button">
                Re-join Hub
              </button>
              <button
                className={styles.secondaryActionBtn}
                onClick={() => void handleBackToFriendHubs()}
                type="button"
              >
                Friend Hubs
              </button>
            </div>
          </div>
        </div>
      );
    }

    if (session.role === 'guest' && !session.entranceAccepted) {
      return (
        <div className={styles.streamViewArea}>
          <GuestKnockGate
            hubId={session.hubId}
            hostName={session.hostInfo.displayName}
            status={session.knockStatus}
            errorMessage={session.knockError}
            onRetry={() => void session.requestEntrance()}
            onCancel={() => void handleCancelKnock()}
            onLeave={() => void handleCancelKnock()}
          />
        </div>
      );
    }

    if (session.isMinimized) {
      return (
        <div className={styles.streamViewArea}>
          <div className={styles.minimizedBar} data-testid="watch-room-minimized-bar">
            <div className={styles.minimizedBarInfo}>
              <div className={styles.minimizedTitleRow}>
                <span className={styles.minimizedLiveDot} />
                <h3>Watch Room Minimized</h3>
              </div>
              <p className={styles.minimizedMeta}>
                {session.hubId} · {session.streams.length}{' '}
                {session.streams.length === 1 ? 'stream' : 'streams'} connected · Video rendering
                paused to save GPU
              </p>
            </div>

            <div className={styles.minimizedBarActions}>
              <button
                className={styles.primaryActionBtn}
                data-testid="restore-watch-room-btn"
                onClick={() => void session.restoreHub()}
                type="button"
              >
                Return to Watch Room
              </button>
              <button
                className={styles.dangerActionBtn}
                data-testid="leave-minimized-btn"
                onClick={() => void handleLeaveRoom()}
                type="button"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      );
    }

    return (
      <MultiStreamHub
        hubId={session.hubId}
        peers={session.peers}
        streams={session.streams}
        isSharing={session.isSharing}
        fps={session.fps}
        isDeafened={session.isDeafened}
        layoutMode={session.layoutMode}
        spotlightStreamId={session.spotlightStreamId}
        fullscreenStreamId={session.fullscreenStreamId}
        systemMetrics={session.systemMetrics}
        highLoadSuggestion={session.highLoadSuggestion}
        connectionFailure={session.connectionFailure}
        onToggleShare={session.toggleSharing}
        onSetFps={session.setFps}
        onToggleFps={session.toggleFps}
        onSetStreamVolume={session.setStreamVolume}
        onToggleDeafen={session.toggleDeafen}
        onToggleLayout={session.toggleLayoutMode}
        onSelectSpotlightStream={session.selectSpotlightStream}
        onEnterFullscreen={session.enterFullscreen}
        onExitFullscreen={session.exitFullscreen}
        onMinimizeHub={session.minimizeHub}
        onLeaveHub={handleLeaveRoom}
        onRetryConnection={session.retryConnection}
        onDismissConnectionFailure={session.dismissConnectionFailure}
        onDismissHighLoadSuggestion={session.dismissHighLoadSuggestion}
      />
    );
  };

  const isMultiStreamRendered =
    !isProfileLoading &&
    Boolean(activeHubSlug) &&
    !session.hasLeftRoom &&
    !(session.role === 'guest' && !session.entranceAccepted) &&
    !session.isMinimized;

  return (
    <div className={styles.streamContainer}>
      <Header
        profile={profile}
        roomTitle={session.hubId || activeHubSlug}
        activeStreamsCount={session.streams.length}
        rttMs={session.systemMetrics.rttMs}
        isConnected={session.isConnected}
        onMinimizeHub={!session.hasLeftRoom && !session.isMinimized ? session.minimizeHub : undefined}
        onCloseStream={handleCloseWindow}
        onOpenProfile={handleOpenProfile}
      />

      {session.role === 'owner' && session.pendingKnocks.length > 0 && (
        <HostKnockAlert
          pendingKnocks={session.pendingKnocks}
          onAccept={session.acceptKnock}
          onReject={session.rejectKnock}
        />
      )}

      {session.connectionFailure && !isMultiStreamRendered && (
        <div className={styles.pageAlertSlot}>
          <ConnectionFailureBanner
            failure={session.connectionFailure}
            onRetry={session.retryConnection}
            onDismiss={session.dismissConnectionFailure}
          />
        </div>
      )}

      {renderMainContent()}

      {isPersonaModalOpen && (
        <div
          className={styles.personaModalBackdrop}
          onClick={() => setIsPersonaModalOpen(false)}
        >
          <div className={styles.personaModalShell} onClick={(e) => e.stopPropagation()}>
            <ChooseNickname
              initialProfile={profile}
              isLoading={isProfileLoading}
              isRegistered={isRegistered}
              telemetryConsent={telemetryConsent}
              onSaveProfile={saveProfile}
              onChangeTelemetryConsent={setTelemetryConsent}
              onCompleteRegistration={() => setIsPersonaModalOpen(false)}
              onCancel={() => setIsPersonaModalOpen(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
};

export default StreamViewerPage;
