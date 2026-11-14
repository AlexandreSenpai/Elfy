import { useCallback, useEffect, useRef, useState } from 'react';
import ShortUniqueId from 'short-unique-id';
import { localWindowBus, storageRepository, telemetryAdapter } from '../adapters';
import { AVATAR_OPTIONS, DEFAULT_USER_PROFILE } from '../data/mockData';
import {
  LocalWindowBusMessage,
  ProfileRowDto,
  StreamFpsOption,
  TelemetryConsentState,
  UserProfile,
} from '../domain/dtos';
import { resolveMachineUid } from '../utils/tauri';

export interface SaveProfileInput {
  nickname: string;
  avatarUrl: string;
  avatarName?: string;
  preferredFps?: StreamFpsOption;
}

export interface UseProfileResult {
  profile: UserProfile;
  isLoading: boolean;
  isRegistered: boolean;
  telemetryConsent: TelemetryConsentState;
  saveProfile: (input: SaveProfileInput) => Promise<UserProfile>;
  setTelemetryConsent: (consent: TelemetryConsentState) => Promise<UserProfile>;
  updatePreferredFps: (fps: StreamFpsOption) => Promise<UserProfile>;
}

const tagGenerator = new ShortUniqueId({ length: 6 });
const profileInitCache = new Map<string, Promise<ProfileRowDto>>();
let hasTrackedAppOpened = false;

const resolveAvatarName = (avatarUrl: string, explicitName?: string): string => {
  if (explicitName && explicitName.trim()) return explicitName.trim();
  const match = AVATAR_OPTIONS.find((item) => item.url === avatarUrl);
  return match?.name ?? DEFAULT_USER_PROFILE.avatarName;
};

const mapRowToProfile = (row: ProfileRowDto, explicitAvatarName?: string): UserProfile => ({
  nickname: row.nickname,
  peerTag: row.peerTag.startsWith('#') ? row.peerTag : `#${row.peerTag}`,
  avatarUrl: row.avatarUrl,
  avatarName: resolveAvatarName(row.avatarUrl, explicitAvatarName),
  telemetryConsent: row.telemetryConsent,
  preferredFps: row.preferredFps,
  machineHash: row.machineHash,
});

const syncTelemetryConsent = (consent: TelemetryConsentState): void => {
  telemetryAdapter.setConsent(consent);
  if (consent !== 'granted' || hasTrackedAppOpened) return;
  hasTrackedAppOpened = true;
  void telemetryAdapter.trackEvent('app_opened');
};

const getOrCreateInitPromise = (uid: string): Promise<ProfileRowDto> => {
  const cached = profileInitCache.get(uid);
  if (cached) return cached;

  const promise = storageRepository
    .getOrInitProfile(uid, {
      nickname: DEFAULT_USER_PROFILE.nickname,
      peerTag: `#${tagGenerator.rnd()}`,
      avatarUrl: DEFAULT_USER_PROFILE.avatarUrl,
    })
    .finally(() => {
      profileInitCache.delete(uid);
    });

  profileInitCache.set(uid, promise);
  return promise;
};

const loadInitializedProfile = async (): Promise<{ uid: string; profile: UserProfile }> => {
  const uid = await resolveMachineUid();
  const row = await getOrCreateInitPromise(uid);
  return { uid, profile: mapRowToProfile(row) };
};

/**
 * Manages the machine-locked user profile, SQLite persistence, telemetry consent,
 * and real-time cross-window synchronization via localWindowBus.
 */
export const useProfile = (): UseProfileResult => {
  const [profile, setProfile] = useState<UserProfile>(DEFAULT_USER_PROFILE);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const profileRef = useRef<UserProfile>(DEFAULT_USER_PROFILE);
  const uidRef = useRef<string | null>(null);

  const applyProfile = useCallback((nextProfile: UserProfile): void => {
    profileRef.current = nextProfile;
    setProfile(nextProfile);
    syncTelemetryConsent(nextProfile.telemetryConsent ?? 'unset');
  }, []);

  const ensureInitializedUid = useCallback(async (): Promise<string> => {
    if (uidRef.current && profileRef.current.machineHash) {
      return uidRef.current;
    }
    const { uid, profile: initialized } = await loadInitializedProfile();
    uidRef.current = uid;
    applyProfile(initialized);
    return uid;
  }, [applyProfile]);

  useEffect(() => {
    let active = true;

    const bootstrap = async (): Promise<void> => {
      try {
        const { uid, profile: loaded } = await loadInitializedProfile();
        if (!active) return;
        uidRef.current = uid;
        applyProfile(loaded);
      } catch (err) {
        console.warn('[useProfile] Failed to initialize profile:', err);
      } finally {
        if (active) setIsLoading(false);
      }
    };

    void bootstrap();

    const unsubscribe = localWindowBus.subscribe((message: LocalWindowBusMessage) => {
      if (message.type !== 'profile_updated') return;
      applyProfile(message.profile);
      setIsLoading(false);
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [applyProfile]);

  const saveProfile = useCallback(
    async (input: SaveProfileInput): Promise<UserProfile> => {
      const uid = await ensureInitializedUid();
      profileInitCache.delete(uid);
      const cleanNickname = input.nickname.trim() || profileRef.current.nickname;
      const cleanAvatar = input.avatarUrl || profileRef.current.avatarUrl;
      const row = await storageRepository.updateProfile(
        uid,
        cleanNickname,
        cleanAvatar,
        input.preferredFps
      );

      const nextProfile = mapRowToProfile(row, input.avatarName);
      applyProfile(nextProfile);
      await localWindowBus.publish({ type: 'profile_updated', profile: nextProfile });
      return nextProfile;
    },
    [applyProfile, ensureInitializedUid]
  );

  const setTelemetryConsent = useCallback(
    async (consent: TelemetryConsentState): Promise<UserProfile> => {
      const uid = await ensureInitializedUid();
      profileInitCache.delete(uid);
      const row = await storageRepository.setTelemetryConsent(uid, consent);
      const nextProfile = mapRowToProfile(row, profileRef.current.avatarName);
      applyProfile(nextProfile);
      await localWindowBus.publish({ type: 'profile_updated', profile: nextProfile });
      return nextProfile;
    },
    [applyProfile, ensureInitializedUid]
  );

  const updatePreferredFps = useCallback(
    async (fps: StreamFpsOption): Promise<UserProfile> => {
      const current = profileRef.current;
      return saveProfile({
        nickname: current.nickname,
        avatarUrl: current.avatarUrl,
        avatarName: current.avatarName,
        preferredFps: fps,
      });
    },
    [saveProfile]
  );

  const telemetryConsent: TelemetryConsentState = profile.telemetryConsent ?? 'unset';
  const isRegistered = !isLoading && Boolean(profile.machineHash);

  return {
    profile,
    isLoading,
    isRegistered,
    telemetryConsent,
    saveProfile,
    setTelemetryConsent,
    updatePreferredFps,
  };
};

export default useProfile;
