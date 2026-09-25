import React, { useEffect, useState } from 'react';
import styles from './ChooseNickname.module.css';
import { AvatarOption, UserProfile } from '../../types';
import { AVATAR_OPTIONS, CUTE_ALIASES, DEFAULT_USER_PROFILE, ELFY_HAPPY, ELFY_MASCOT_ICON } from '../../data/mockData';
import { closeRegisterWindowTauri, startDraggingTauri } from '../../utils/tauri';
import ShortUniqueId from 'short-unique-id';
import { db, IUsers } from '../../database';
import { commands } from "@skipperndt/plugin-machine-uid";

interface ChooseNicknameProps {
  initialProfile: UserProfile;
  onCompleteRegistration?: (profile: UserProfile) => void;
  onCancel?: () => void;
}

const tagGenerator = new ShortUniqueId({ length: 6 });

export const ChooseNickname: React.FC<ChooseNicknameProps> = ({
  initialProfile,
  onCompleteRegistration,
  onCancel
}) => {
  const [nickname, setNickname] = useState(initialProfile.nickname);
  const [peerTag, setPeerTag] = useState(() => {
    return initialProfile.peerTag ? initialProfile.peerTag.replace('#', '') : tagGenerator.rnd();
  });
  const [selectedAvatar, setSelectedAvatar] = useState<AvatarOption>(() => {
    const found = AVATAR_OPTIONS.find((a) => a.url === initialProfile.avatarUrl);
    return found || AVATAR_OPTIONS[0];
  });
  const [isExistingUser, setIsExistingUser] = useState(false);
  const [isSpinning, setIsSpinning] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const currentAvatarUrl = selectedAvatar.url;

  useEffect(() => {
    fetchCurrentUserData();
  }, []);

  const fetchCurrentUserData = async () => {
    try {
      const machine = await commands.getMachineUid();
      
      if (machine.status === 'error' || !machine.data.id) {
        console.error(machine);
        return;
      }

      const currentData = await db.table<IUsers>("users").get(machine.data.id);
      
      if (!currentData) {
        setIsExistingUser(false);
        return;
      }

      // User already exists in database: lock peer tag, populate name & avatar
      setIsExistingUser(true);
      setNickname(currentData.name);
      setPeerTag(currentData.id);
      if (currentData.avatar) {
        const found = AVATAR_OPTIONS.find((a) => a.url === currentData.avatar);
        if (found) {
          setSelectedAvatar(found);
        }
      }
    } catch (err) {
      console.error('Error querying existing user in database:', err);
    }
  };

  const handleRollDice = () => {
    setIsSpinning(true);
    setTimeout(() => setIsSpinning(false), 300);

    const randomName = CUTE_ALIASES[Math.floor(Math.random() * CUTE_ALIASES.length)];
    setNickname(randomName);

    // If user already exists in DB, we cannot change its peer tag, only name & avatar
    if (!isExistingUser) {
      const randomTag = tagGenerator.rnd();
      setPeerTag(randomTag);
    }
  };

  const handleSelectAvatarOption = (opt: AvatarOption) => {
    setSelectedAvatar(opt);
  };

  const handleResetAvatar = () => {
    setSelectedAvatar({
      id: 'default',
      label: 'default',
      name: 'default',
      url: DEFAULT_USER_PROFILE.avatarUrl
    });
  };

  const handleCopyId = () => {
    const fullId = `${nickname.trim() || 'Companion'}#${peerTag}`;
    navigator.clipboard?.writeText(fullId).catch(() => {});
  };

  const handleClose = async () => {
    if (onCancel) {
      onCancel();
    } else {
      await closeRegisterWindowTauri();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);

    const machine = await commands.getMachineUid();
    if (machine.status === 'error' || !machine.data.id) {
      setIsSubmitting(false);
      setIsSuccess(false);
      throw new Error("Could not fetch Machine ID");
    }
    
    try {
      // Re-verify against DB to guarantee peer tag immutability for existing users
      const currentData = await db.table<IUsers>("users").get(machine.data.id);
      const finalPeerTag = currentData ? currentData.id : peerTag;

      const user: IUsers = {
        machine: machine.data.id,
        id: finalPeerTag,
        name: nickname.trim() || 'Companion',
        avatar: currentAvatarUrl
      };

      await db.table<IUsers>('users').put(user);
      setIsSuccess(true);
      setIsExistingUser(true);
      
      onCompleteRegistration?.({
        nickname: user.name,
        peerTag: user.id.startsWith('#') ? user.id : `#${user.id}`,
        avatarUrl: user.avatar,
        avatarName: selectedAvatar.name
      });
    } catch (err: unknown) {
      setIsSuccess(false);
      console.error(err);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button, input, select, textarea, a, [role="button"], [data-no-drag]')) {
      return;
    }
    startDraggingTauri();
  };

  return (
    <div className={styles.wrapper}>
      <div className={styles.windowFrame}>
        {/* Title Bar with Drag Region */}
        <div
          className={styles.titleBar}
          onMouseDown={handleMouseDown}
        >
          <div className={styles.titleCenter}>
            <div className={styles.titleMascot}>
              <img src={ELFY_MASCOT_ICON} alt="Elfy mascot" />
            </div>
            <span className={`material-symbols-outlined ${styles.boltIcon}`}>bolt</span>
            <span>Elfy • {isExistingUser ? 'Edit Persona' : 'Setup'}</span>
          </div>
        
          <button
            className={styles.closeSetupBtn}
            onClick={handleClose}
            title="Close Setup"
            type="button"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
              close
            </span>
          </button>
        </div>

        {/* Content Canvas */}
        <main className={styles.canvas}>
          <div className={styles.auraTop} />

          <div className={styles.onboardingCard}>
            {/* Window Sub-Header & Mascot Badge */}
            <div className={styles.cardHeader}>
              <div className={styles.cardHeaderBrand}>
                <div className={styles.mascotBadge}>
                  <img src={ELFY_HAPPY} alt="Elfy mascot" />
                  <span className={styles.mascotStatusDot} />
                </div>
                <div className={styles.cardHeaderTitles}>
                  <span className={styles.cardTitle}>Elfy</span>
                  <span className={styles.cardSubtitle}>
                    {isExistingUser ? 'Persona Profile' : 'Version v1.0'}
                  </span>
                </div>
              </div>
            </div>

            {/* Welcome Lead In */}
            <div className={styles.welcomeWrap}>
              <h1 className={styles.welcomeHeading}>
                {isExistingUser ? (
                  <>Update your <span className={styles.welcomeAccent}>Persona</span></>
                ) : (
                  <>Welcome to <span className={styles.welcomeAccent}>Elfy</span></>
                )}
              </h1>
              <p className={styles.welcomeDesc}>
                {isExistingUser
                  ? 'Update your name and avatar anytime. Your peer tag is permanently assigned to this machine.'
                  : 'Pick your alias and avatar for your local mesh hubs. Zero logins, no passwords, strictly peer-to-peer.'}
              </p>
            </div>

            {/* Persona Avatar Mosaic */}
            <div className={styles.avatarSection}>
              <div className={styles.avatarHeaderRow}>
                <span className={styles.avatarSectionLabel}>Select Persona Avatar</span>
                <button className={styles.keepDefaultBtn} onClick={handleResetAvatar} type="button">
                  Keep Default
                </button>
              </div>

              <div className={styles.avatarMainRow}>
                {/* Hero Avatar Preview */}
                <div className={styles.heroAvatarWrap}>
                  <div className={styles.heroAvatarBorder}>
                    <div className={styles.heroAvatarInner}>
                      <img src={currentAvatarUrl} alt="Active Avatar" className={styles.heroAvatarImg} />
                    </div>
                  </div>
                </div>

                {/* Swatches Grid */}
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

            {/* Handle Alias Input & Randomizer */}
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
                    placeholder="e.g. Nova, CozyPixie, Kitsune"
                    onChange={(e) => setNickname(e.target.value)}
                  />
                  <span
                    className={styles.tagSuffix}
                    title={isExistingUser ? "Peer tag is permanent for this machine" : undefined}
                  >
                    #{peerTag}
                    {isExistingUser && (
                      <span
                        className="material-symbols-outlined"
                        style={{ fontSize: '13px', marginLeft: '4px', verticalAlign: 'middle', opacity: 0.7 }}
                      >
                        lock
                      </span>
                    )}
                  </span>
                </div>

                <button
                  className={`${styles.diceBtn} ${isSpinning ? styles.diceSpin : ''}`}
                  onClick={handleRollDice}
                  title={isExistingUser ? "Roll random nickname (Peer tag is locked)" : "Roll random cute alias"}
                  type="button"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>
                    casino
                  </span>
                </button>
              </div>

              {/* Public ID Live Preview */}
              <div className={styles.idPreviewRow}>
                <div className={styles.previewIdWrap}>
                  <span>PUBLIC ID:</span>
                  <span className={styles.previewPill}>
                    {(nickname.trim() || 'Companion') + "#" + peerTag}
                  </span>
                  <span
                    className={`material-symbols-outlined ${styles.copyIdIcon}`}
                    style={{ fontSize: '13px' }}
                    onClick={handleCopyId}
                    title="Copy identifier"
                  >
                    content_copy
                  </span>
                </div>
              </div>
            </div>

            {/* CTA Submit Button */}
            <div className={styles.ctaWrap}>
              <button
                className={`${styles.ctaBtn} ${isSuccess ? styles.ctaSuccess : ''}`}
                onClick={handleSubmit}
                disabled={isSubmitting}
                type="button"
              >
                {isSubmitting ? (
                  <>
                    <span
                      className="material-symbols-outlined"
                      style={{ fontSize: '16px', animation: 'spin 1s infinite linear' }}
                    >
                      sync
                    </span>
                    <span>Saving Persona...</span>
                  </>
                ) : isSuccess ? (
                  <>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                      check_circle
                    </span>
                    <span>Saved!</span>
                  </>
                ) : isExistingUser ? (
                  <>
                    <span>Save Changes</span>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                      check
                    </span>
                  </>
                ) : (
                  <>
                    <span>Get Started</span>
                    <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>
                      arrow_forward
                    </span>
                  </>
                )}
              </button>

              <div className={styles.privacyNote}>
                <span className={`material-symbols-outlined ${styles.lockIcon}`}>lock</span>
                <span>
                  {isExistingUser
                    ? 'Peer tag permanently registered to this device in Dexie DB.'
                    : 'Stored locally. Peer-to-peer only.'}
                </span>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
};
