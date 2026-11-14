import React, { useEffect, useRef, useState } from 'react';
import styles from './ChooseNickname.module.css';
import { AvatarOption, TelemetryConsentState, UserProfile } from '../../domain/dtos';
import { SaveProfileInput } from '../../hooks/useProfile';
import {
  AVATAR_OPTIONS,
  CUTE_ALIASES,
  DEFAULT_USER_PROFILE,
  ELFY_HAPPY,
  ELFY_MASCOT_ICON,
} from '../../data/mockData';
import { closeRegisterWindowTauri, isTauri, startDraggingTauri } from '../../utils/tauri';

interface ChooseNicknameProps {
  initialProfile: UserProfile;
  isLoading?: boolean;
  isRegistered?: boolean;
  telemetryConsent: TelemetryConsentState;
  onSaveProfile: (input: SaveProfileInput) => Promise<UserProfile>;
  onChangeTelemetryConsent: (consent: TelemetryConsentState) => Promise<UserProfile>;
  onCompleteRegistration?: (profile: UserProfile) => void | Promise<void>;
  onCancel?: () => void;
}

const findAvatarByUrl = (avatarUrl: string): AvatarOption => {
  const match = AVATAR_OPTIONS.find((item) => item.url === avatarUrl);
  if (match) return match;
  return {
    id: 'default',
    label: 'default',
    name: DEFAULT_USER_PROFILE.avatarName,
    url: avatarUrl || DEFAULT_USER_PROFILE.avatarUrl,
  };
};

const stripTagPrefix = (peerTag: string): string => {
  return peerTag.replace(/^#/, '').trim();
};

const getSubmitLabel = (
  isSubmitting: boolean,
  isSuccess: boolean,
  isExistingUser: boolean
): { icon: string; text: string; spinning: boolean } => {
  if (isSubmitting) return { icon: 'sync', text: 'Saving Persona...', spinning: true };
  if (isSuccess) return { icon: 'check_circle', text: 'Saved!', spinning: false };
  if (isExistingUser) return { icon: 'check', text: 'Save Changes', spinning: false };
  return { icon: 'arrow_forward', text: 'Get Started', spinning: false };
};

export const ChooseNickname: React.FC<ChooseNicknameProps> = ({
  initialProfile,
  isLoading = false,
  isRegistered = false,
  telemetryConsent,
  onSaveProfile,
  onChangeTelemetryConsent,
  onCompleteRegistration,
  onCancel,
}) => {
  const [nickname, setNickname] = useState(initialProfile.nickname);
  const [selectedAvatar, setSelectedAvatar] = useState<AvatarOption>(() =>
    findAvatarByUrl(initialProfile.avatarUrl)
  );
  const [isSpinning, setIsSpinning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUpdatingTelemetry, setIsUpdatingTelemetry] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const hasEditedRef = useRef(false);

  const lockedTag = stripTagPrefix(initialProfile.peerTag);
  const isExistingUser = isRegistered || Boolean(initialProfile.machineHash);
  const telemetryEnabled = telemetryConsent === 'granted';

  useEffect(() => {
    if (isLoading || hasEditedRef.current) return;
    setNickname(initialProfile.nickname);
    setSelectedAvatar(findAvatarByUrl(initialProfile.avatarUrl));
  }, [initialProfile.avatarUrl, initialProfile.machineHash, initialProfile.nickname, isLoading]);

  const handleNicknameChange = (value: string): void => {
    hasEditedRef.current = true;
    setIsSuccess(false);
    setErrorMessage(null);
    setNickname(value);
  };

  const handleRollDice = (): void => {
    hasEditedRef.current = true;
    setIsSuccess(false);
    setIsSpinning(true);
    window.setTimeout(() => setIsSpinning(false), 300);

    const randomName = CUTE_ALIASES[Math.floor(Math.random() * CUTE_ALIASES.length)];
    setNickname(randomName);
  };

  const handleSelectAvatarOption = (opt: AvatarOption): void => {
    hasEditedRef.current = true;
    setIsSuccess(false);
    setSelectedAvatar(opt);
  };

  const handleResetAvatar = (): void => {
    hasEditedRef.current = true;
    setIsSuccess(false);
    setSelectedAvatar({
      id: 'default',
      label: 'default',
      name: DEFAULT_USER_PROFILE.avatarName,
      url: DEFAULT_USER_PROFILE.avatarUrl,
    });
  };

  const handleCopyId = (): void => {
    const fullId = `${nickname.trim() || 'Companion'}#${lockedTag}`;
    navigator.clipboard?.writeText(fullId).catch(() => {});
  };

  const handleClose = async (): Promise<void> => {
    if (onCancel) {
      onCancel();
      return;
    }
    if (isTauri()) {
      await closeRegisterWindowTauri();
    }
  };

  const handleToggleTelemetry = async (): Promise<void> => {
    if (isUpdatingTelemetry) return;
    setIsUpdatingTelemetry(true);
    setErrorMessage(null);
    const nextConsent: TelemetryConsentState = telemetryEnabled ? 'denied' : 'granted';
    try {
      await onChangeTelemetryConsent(nextConsent);
    } catch {
      setErrorMessage('Could not update telemetry preference.');
    } finally {
      setIsUpdatingTelemetry(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (isSubmitting || isLoading) return;

    setIsSubmitting(true);
    setErrorMessage(null);
    try {
      const saved = await onSaveProfile({
        nickname: nickname.trim() || 'Companion',
        avatarUrl: selectedAvatar.url,
        avatarName: selectedAvatar.name,
      });
      hasEditedRef.current = false;
      setIsSuccess(true);
      await onCompleteRegistration?.(saved);
    } catch {
      setIsSuccess(false);
      setErrorMessage('Failed to save persona to local SQLite database.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent): void => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [role="switch"], [data-no-drag]')) {
      return;
    }
    startDraggingTauri();
  };

  const submitState = getSubmitLabel(isSubmitting, isSuccess, isExistingUser);
  const displayNickname = nickname.trim() || 'Companion';

  return (
    <div className={styles.wrapper}>
      <div className={styles.windowFrame}>
        <div className={styles.titleBar} onMouseDown={handleMouseDown}>
          <div className={styles.titleCenter}>
            <div className={styles.titleMascot}>
              <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" />
            </div>
            <span className={`material-symbols-outlined ${styles.boltIcon}`}>bolt</span>
            <span>Elfy • {isExistingUser ? 'Edit Persona' : 'Setup'}</span>
          </div>

          <button
            className={styles.closeSetupBtn}
            onClick={() => void handleClose()}
            title="Close Setup"
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              close
            </span>
          </button>
        </div>

        <main className={styles.canvas}>
          <div className={styles.auraTop} />

          <form className={styles.onboardingCard} onSubmit={(e) => void handleSubmit(e)}>
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderBrand}>
                <div className={styles.mascotBadge}>
                  <img src={ELFY_HAPPY} alt="Elfy mascot" />
                  <span className={styles.mascotStatusDot} />
                </div>
                <div className={styles.cardHeaderTitles}>
                  <span className={styles.cardTitle}>Elfy</span>
                  <span className={styles.cardSubtitle}>
                    {isExistingUser ? 'Persona & Privacy' : 'Local Mesh Setup'}
                  </span>
                </div>
              </div>

              <div className={styles.discoveryBadge}>
                <span className={styles.discoveryDot} />
                <span>MACHINE LOCKED</span>
              </div>
            </div>

            <div className={styles.welcomeWrap}>
              <h1 className={styles.welcomeHeading}>
                {isExistingUser ? 'Update your ' : 'Welcome to '}
                <span className={styles.welcomeAccent}>
                  {isExistingUser ? 'Persona' : 'Elfy'}
                </span>
              </h1>
              <p className={styles.welcomeDesc}>
                Update your nickname and avatar anytime. Your peer tag is permanently locked to
                this machine and backed by local SQLite storage.
              </p>
            </div>

            <div className={styles.avatarSection}>
              <div className={styles.avatarHeaderRow}>
                <span className={styles.avatarSectionLabel}>Select Persona Avatar</span>
                <button className={styles.keepDefaultBtn} onClick={handleResetAvatar} type="button">
                  Keep Default
                </button>
              </div>

              <div className={styles.avatarMainRow}>
                <div className={styles.heroAvatarWrap}>
                  <div className={styles.heroAvatarBorder}>
                    <div className={styles.heroAvatarInner}>
                      <img src={selectedAvatar.url} alt="Active Avatar" className={styles.heroAvatarImg} />
                    </div>
                  </div>
                </div>

                <div className={styles.swatchesContainer}>
                  <div className={styles.swatchesGrid}>
                    {AVATAR_OPTIONS.map((opt) => {
                      const isActive = selectedAvatar.id === opt.id;
                      return (
                        <button
                          key={opt.id}
                          className={`${styles.swatchBtn} ${isActive ? styles.swatchBtnActive : ''}`}
                          onClick={() => handleSelectAvatarOption(opt)}
                          type="button"
                        >
                          <div className={styles.swatchThumb}>
                            <img src={opt.url} alt={opt.name} />
                          </div>
                          <span className={`${styles.swatchLabel} ${isActive ? styles.swatchLabelActive : ''}`}>
                            {opt.label}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            <div className={styles.aliasSection}>
              <div className={styles.aliasHeader}>
                <span className={styles.aliasLabel}>Your Nickname</span>
                <span className={styles.requiredTag}>REQUIRED</span>
              </div>

              <div className={styles.aliasInputRow}>
                <div className={styles.inputCapsule}>
                  <span className={`material-symbols-outlined ${styles.inputBadgeIcon}`} style={{ fontSize: '16px' }}>
                    badge
                  </span>
                  <input
                    className={styles.aliasTextInput}
                    type="text"
                    maxLength={20}
                    value={nickname}
                    disabled={isLoading}
                    placeholder="e.g. Nova, CozyPixie, Kitsune"
                    onChange={(e) => handleNicknameChange(e.target.value)}
                  />
                  <span
                    className={styles.tagSuffix}
                    data-testid="locked-peer-tag"
                    title="Peer tag is permanently locked to this machine"
                  >
                    #{lockedTag}
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: '13px', marginLeft: '4px', verticalAlign: 'middle', opacity: 0.75 }}
                    >
                      lock
                    </span>
                  </span>
                </div>

                <button
                  className={`${styles.diceBtn} ${isSpinning ? styles.diceSpin : ''}`}
                  onClick={handleRollDice}
                  title="Roll random nickname (Peer tag stays locked)"
                  type="button"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                    casino
                  </span>
                </button>
              </div>

              <div className={styles.idPreviewRow}>
                <div className={styles.previewIdWrap}>
                  <span>PUBLIC ID:</span>
                  <span className={styles.previewPill}>
                    {displayNickname}#{lockedTag}
                  </span>
                  <button
                    className={styles.copyIconBtn}
                    onClick={handleCopyId}
                    title="Copy identifier"
                    type="button"
                  >
                    <span className={`material-symbols-outlined ${styles.copyIdIcon}`} style={{ fontSize: '13px' }}>
                      content_copy
                    </span>
                  </button>
                </div>
              </div>
            </div>

            <div className={styles.toggleCard}>
              <div className={styles.toggleLeft}>
                <div className={styles.toggleIconBox}>
                  <span className="material-symbols-outlined" style={{ fontSize: '17px' }}>
                    monitoring
                  </span>
                </div>
                <div className={styles.toggleTextGroup}>
                  <span className={styles.toggleTitle}>Anonymous Performance Telemetry</span>
                  <span className={styles.toggleDesc}>
                    Shares FPS, latency, and load tier only. Never nicknames, hubs, or video.
                  </span>
                </div>
              </div>

              <button
                aria-checked={telemetryEnabled}
                aria-label="Toggle anonymous performance telemetry"
                className={`${styles.toggleSwitchBtn} ${telemetryEnabled ? styles.toggleSwitchActive : ''}`}
                data-testid="telemetry-toggle"
                disabled={isUpdatingTelemetry || isLoading}
                onClick={() => void handleToggleTelemetry()}
                role="switch"
                type="button"
              >
                <span className={styles.toggleThumb} />
              </button>
            </div>

            {errorMessage && (
              <p className={styles.errorText} role="alert">
                {errorMessage}
              </p>
            )}

            <div className={styles.ctaWrap}>
              <button
                className={`${styles.ctaBtn} ${isSuccess ? styles.ctaSuccess : ''}`}
                disabled={isSubmitting || isLoading}
                type="submit"
              >
                <span
                  className={`material-symbols-outlined ${submitState.spinning ? styles.spinIcon : ''}`}
                  style={{ fontSize: '16px' }}
                >
                  {submitState.icon}
                </span>
                <span>{submitState.text}</span>
              </button>

              <div className={styles.privacyNote}>
                <span className={`material-symbols-outlined ${styles.lockIcon}`}>lock</span>
                <span>
                  Peer tag is permanently registered to this machine in SQLite local storage.
                </span>
              </div>
            </div>
          </form>
        </main>
      </div>
    </div>
  );
};

export default ChooseNickname;
