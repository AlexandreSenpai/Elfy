import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  const [isPanelOpen, setIsPanelOpen] = useState(false);
  const [inspectedTelemetryPeerId, setInspectedTelemetryPeerId] = useState<string | null>(null);

  useEffect(() => {
    setOverrideHubSlug(null);
    setOverrideAutoStart(null);
    setOverrideJoinedAs(null);
    setIsPanelOpen(false);
    setInspectedTelemetryPeerId(null);
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
        !sessionActionsRef.current.kickedReason &&
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
      setIsPanelOpen(false);
      setInspectedTelemetryPeerId(null);
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
    kickedReason: session.kickedReason,
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
    kickedReason: session.kickedReason,
    isMinimized: session.isMinimized,
    rejoinRoom: session.rejoinRoom,
    restoreHub: session.restoreHub,
    startSharing: session.startSharing,
  };

  useEffect(() => {
    if (session.kickedReason || session.hasLeftRoom || session.isMinimized) {
      setIsPanelOpen(false);
      setInspectedTelemetryPeerId(null);
    }
  }, [session.hasLeftRoom, session.isMinimized, session.kickedReason]);

  const closingOnLeaveRef = useRef<boolean>(false);

  const handleBackToFriendHubs = useCallback(async (): Promise<void> => {
    if (isTauri()) {
      await closeStreamWindowTauri();
      return;
    }
    navigate('/');
  }, [navigate]);

  useEffect(() => {
    if (!session.hasLeftRoom) {
      closingOnLeaveRef.current = false;
      return;
    }
    if (closingOnLeaveRef.current) return;
    closingOnLeaveRef.current = true;
    void handleBackToFriendHubs();
  }, [handleBackToFriendHubs, session.hasLeftRoom]);

  const handleLeaveRoom = async (): Promise<void> => {
    closingOnLeaveRef.current = true;
    setIsPanelOpen(false);
    setInspectedTelemetryPeerId(null);
    session.clearKickedState();
    await session.leaveRoom();
    await handleBackToFriendHubs();
  };

  const handleCloseWindow = async (): Promise<void> => {
    closingOnLeaveRef.current = true;
    setIsPanelOpen(false);
    setInspectedTelemetryPeerId(null);
    session.clearKickedState();
    await session.leaveRoom();
    await handleBackToFriendHubs();
  };

  const handleReturnFromKick = async (): Promise<void> => {
    setIsPanelOpen(false);
    setInspectedTelemetryPeerId(null);
    session.clearKickedState();
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

  const handleTogglePanel = useCallback((): void => {
    setIsPanelOpen((prev) => {
      if (prev) {
        setInspectedTelemetryPeerId(null);
        return false;
      }
      return true;
    });
  }, []);

  const handleSelectTelemetryPeer = useCallback((peerIdSafe: string | null): void => {
    setInspectedTelemetryPeerId(peerIdSafe);
    if (peerIdSafe !== null) {
      setIsPanelOpen(true);
    }
  }, []);

  const handleClosePanel = useCallback((): void => {
    setIsPanelOpen(false);
    setInspectedTelemetryPeerId(null);
  }, []);

  const renderMainContent = () => {
    if (isProfileLoading) {
      return (
        <div className={styles.streamViewArea}>
          <div className={styles.statusBox}>
            <h3>Loading Watch Room...</h3>
            <p>Preparing your Hub session...</p>
          </div>
        </div>
      );
    }

    if (!activeHubSlug) {
      return (
        <div className={styles.streamViewArea}>
          <div className={styles.statusBox}>
            <h3>No Hub Selected</h3>
            <p>Pick a Friend Hub or enter a Hub ID to join or open a watch room.</p>
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
      return null;
    }

    if (session.kickedReason) {
      return (
        <div className={styles.streamViewArea}>
          <div
            className={styles.kickedBannerCard}
            data-testid="kicked-from-room-banner"
            role="alert"
          >
            <div className={styles.kickedIconCircle}>
              <span className="material-symbols-outlined" style={{ fontSize: '30px', color: 'var(--error)' }}>
                person_remove
              </span>
            </div>
            <h3>Removed from Room</h3>
            <p>
              You were removed from the room by the host. All stream playback and peer connections
              have stopped.
            </p>
            <span className={styles.kickedReasonPill}>{session.kickedReason}</span>
            <button
              className={styles.primaryActionBtn}
              data-testid="kicked-back-home-btn"
              onClick={() => void handleReturnFromKick()}
              type="button"
            >
              Back to Friend Hubs
            </button>
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
        localPeerIdSafe={session.localPeerIdSafe}
        localRole={session.role}
        peers={session.peers}
        streams={session.streams}
        streamVolumes={session.streamVolumes}
        isSharing={session.isSharing}
        isLocalPreviewEnabled={session.isLocalPreviewEnabled}
        fps={session.fps}
        resolution={session.resolution}
        isDeafened={session.isDeafened}
        isConnected={session.isConnected}
        layoutMode={session.layoutMode}
        spotlightStreamId={session.spotlightStreamId}
        fullscreenStreamId={session.fullscreenStreamId}
        isPanelOpen={isPanelOpen}
        inspectedTelemetryPeerId={inspectedTelemetryPeerId}
        systemMetrics={session.systemMetrics}
        telemetryHistory={session.telemetryHistory}
        peerTelemetryHistory={session.peerTelemetryHistory}
        highLoadSuggestion={session.highLoadSuggestion}
        connectionFailure={session.connectionFailure}
        onSelectTelemetryPeer={handleSelectTelemetryPeer}
        onClosePanel={handleClosePanel}
        onToggleShare={session.toggleSharing}
        onToggleLocalPreview={session.toggleLocalPreview}
        onSetFps={session.setFps}
        onSetResolution={session.setResolution}
        onSetStreamVolume={session.setStreamVolume}
        onToggleDeafen={session.toggleDeafen}
        onToggleLayout={session.toggleLayoutMode}
        onSelectLayoutMode={session.setLayoutMode}
        onSelectSpotlightStream={session.selectSpotlightStream}
        onEnterFullscreen={session.enterFullscreen}
        onExitFullscreen={session.exitFullscreen}
        onLeaveHub={handleLeaveRoom}
        onKickPeer={session.kickPeer}
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
    !session.kickedReason &&
    !(session.role === 'guest' && !session.entranceAccepted) &&
    !session.isMinimized;

  return (
    <div
      className={styles.streamContainer}
      data-signaling-connected={String(session.isConnected)}
    >
      <Header
        profile={profile}
        roomTitle={session.hubId || activeHubSlug}
        layoutMode={isMultiStreamRendered ? session.layoutMode : undefined}
        onSelectLayoutMode={isMultiStreamRendered ? session.setLayoutMode : undefined}
        peers={isMultiStreamRendered ? session.peers : undefined}
        isPanelOpen={isMultiStreamRendered ? isPanelOpen : false}
        onTogglePanel={isMultiStreamRendered ? handleTogglePanel : undefined}
        onMinimizeHub={
          !session.hasLeftRoom && !session.kickedReason && !session.isMinimized
            ? session.minimizeHub
            : undefined
        }
        onCloseStream={handleCloseWindow}
        onOpenProfile={handleOpenProfile}
      />

      {session.role === 'owner' && !session.kickedReason && session.pendingKnocks.length > 0 && (
        <HostKnockAlert
          pendingKnocks={session.pendingKnocks}
          onAccept={session.acceptKnock}
          onReject={session.rejectKnock}
        />
      )}

      {session.connectionFailure && !isMultiStreamRendered && !session.kickedReason && (
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
