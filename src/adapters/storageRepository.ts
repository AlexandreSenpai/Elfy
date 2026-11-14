import {
  FriendHubRecordDto,
  ProfileRowDto,
  StreamFpsOption,
  TelemetryConsentState,
} from '../domain/dtos';
import { isRecord, isTelemetryConsentState } from '../domain/validators';
import { IStorageRepository, ProfileInitDefaults } from '../ports';
import {
  dbGetOrInitProfileTauri,
  dbListFriendHubsTauri,
  dbRemoveFriendHubTauri,
  dbSetTelemetryConsentTauri,
  dbUpdateProfileTauri,
  dbUpsertFriendHubTauri,
  isTauri,
  resolveMachineUid,
} from '../utils/tauri';

interface TestDbBucket {
  profile: ProfileRowDto | null;
  friendHubs: FriendHubRecordDto[];
}

const TEST_DB_PREFIX = 'elfy_test_db_';

const normalizeFps = (fps: number): StreamFpsOption => {
  return fps === 30 ? 30 : 60;
};

const normalizePeerTag = (tag: string): string => {
  const trimmed = tag.trim();
  if (!trimmed) return '#000000';
  return trimmed.startsWith('#') ? trimmed : `#${trimmed}`;
};

const normalizeProfileRow = (row: ProfileRowDto): ProfileRowDto => ({
  machineHash: row.machineHash,
  peerTag: normalizePeerTag(row.peerTag),
  nickname: row.nickname,
  avatarUrl: row.avatarUrl,
  telemetryConsent: isTelemetryConsentState(row.telemetryConsent) ? row.telemetryConsent : 'unset',
  preferredFps: normalizeFps(row.preferredFps),
  updatedAt: row.updatedAt,
});

const normalizeFriendHubRecord = (row: FriendHubRecordDto): FriendHubRecordDto => ({
  hubId: row.hubId,
  ownerNickname: row.ownerNickname,
  ownerTag: row.ownerTag,
  ownerAvatar: row.ownerAvatar ?? '',
  lastJoinedAt: row.lastJoinedAt,
  isFavorite: Boolean(row.isFavorite),
});

const sortHubsByRecent = (hubs: FriendHubRecordDto[]): FriendHubRecordDto[] => {
  return [...hubs].sort((a, b) => b.lastJoinedAt - a.lastJoinedAt);
};

const fallbackHexHash = (input: string): string => {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
  }
  return `${h1.toString(16).padStart(8, '0')}${h2.toString(16).padStart(8, '0')}`;
};

const hashMachineUid = async (rawMachineUid: string): Promise<string> => {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    return fallbackHexHash(rawMachineUid);
  }
  const encoded = new TextEncoder().encode(rawMachineUid);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, '0')).join('');
};

/** SQLite-backed persistence repository invoking Tauri Rust commands. */
export class SqliteStorageRepository implements IStorageRepository {
  async getOrInitProfile(
    rawMachineUid: string,
    defaults: ProfileInitDefaults
  ): Promise<ProfileRowDto> {
    const hash = await hashMachineUid(rawMachineUid);
    const fixedTag = hash ? `#${hash.slice(0, 10)}` : normalizePeerTag(defaults.peerTag);
    const row = await dbGetOrInitProfileTauri(
      rawMachineUid,
      defaults.nickname,
      fixedTag,
      defaults.avatarUrl
    );
    return normalizeProfileRow(row);
  }

  async updateProfile(
    rawMachineUid: string,
    nickname: string,
    avatarUrl: string,
    preferredFps?: StreamFpsOption
  ): Promise<ProfileRowDto> {
    const row = await dbUpdateProfileTauri(rawMachineUid, nickname, avatarUrl, preferredFps);
    return normalizeProfileRow(row);
  }

  async setTelemetryConsent(
    rawMachineUid: string,
    consent: TelemetryConsentState
  ): Promise<ProfileRowDto> {
    const row = await dbSetTelemetryConsentTauri(rawMachineUid, consent);
    return normalizeProfileRow(row);
  }

  async listFriendHubs(): Promise<FriendHubRecordDto[]> {
    const rows = await dbListFriendHubsTauri();
    return sortHubsByRecent(rows.map(normalizeFriendHubRecord));
  }

  async upsertFriendHub(hub: FriendHubRecordDto): Promise<FriendHubRecordDto[]> {
    const rows = await dbUpsertFriendHubTauri(normalizeFriendHubRecord(hub));
    return sortHubsByRecent(rows.map(normalizeFriendHubRecord));
  }

  async removeFriendHub(hubId: string): Promise<FriendHubRecordDto[]> {
    const rows = await dbRemoveFriendHubTauri(hubId);
    return sortHubsByRecent(rows.map(normalizeFriendHubRecord));
  }
}

const parseTestProfile = (raw: unknown): ProfileRowDto | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.machineHash !== 'string' || typeof raw.peerTag !== 'string') return null;
  if (typeof raw.nickname !== 'string' || typeof raw.avatarUrl !== 'string') return null;
  return normalizeProfileRow({
    machineHash: raw.machineHash,
    peerTag: raw.peerTag,
    nickname: raw.nickname,
    avatarUrl: raw.avatarUrl,
    telemetryConsent: isTelemetryConsentState(raw.telemetryConsent) ? raw.telemetryConsent : 'unset',
    preferredFps: raw.preferredFps === 30 ? 30 : 60,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : Date.now(),
  });
};

const parseTestFriendHub = (raw: unknown): FriendHubRecordDto | null => {
  if (!isRecord(raw)) return null;
  if (typeof raw.hubId !== 'string' || typeof raw.ownerNickname !== 'string') return null;
  if (typeof raw.ownerTag !== 'string') return null;
  return normalizeFriendHubRecord({
    hubId: raw.hubId,
    ownerNickname: raw.ownerNickname,
    ownerTag: raw.ownerTag,
    ownerAvatar: typeof raw.ownerAvatar === 'string' ? raw.ownerAvatar : '',
    lastJoinedAt: typeof raw.lastJoinedAt === 'number' ? raw.lastJoinedAt : Date.now(),
    isFavorite: Boolean(raw.isFavorite),
  });
};

const parseTestBucket = (raw: string | null): TestDbBucket => {
  if (!raw) return { profile: null, friendHubs: [] };

  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { profile: null, friendHubs: [] };
    const profile = parseTestProfile(parsed.profile);
    const rawHubs = Array.isArray(parsed.friendHubs) ? parsed.friendHubs : [];
    const friendHubs = rawHubs
      .map(parseTestFriendHub)
      .filter((item): item is FriendHubRecordDto => item !== null);
    return { profile, friendHubs };
  } catch {
    return { profile: null, friendHubs: [] };
  }
};

/**
 * Testing-only repository for headless browser / Playwright multi-peer tests.
 * Isolates state per hashed machine UID in localStorage. Never used inside Tauri.
 */
export class TestFallbackStorageRepository implements IStorageRepository {
  private lastMachineHash: string | null = null;

  private async resolveBucketKey(rawMachineUid?: string): Promise<{ hash: string; key: string }> {
    const uid = rawMachineUid || (await resolveMachineUid());
    const hash = await hashMachineUid(uid);
    this.lastMachineHash = hash;
    return { hash, key: `${TEST_DB_PREFIX}${hash}` };
  }

  private async resolveActiveKey(): Promise<string> {
    if (this.lastMachineHash) return `${TEST_DB_PREFIX}${this.lastMachineHash}`;
    const resolved = await this.resolveBucketKey();
    return resolved.key;
  }

  private readBucket(key: string): TestDbBucket {
    return parseTestBucket(localStorage.getItem(key));
  }

  private writeBucket(key: string, bucket: TestDbBucket): void {
    localStorage.setItem(key, JSON.stringify(bucket));
  }

  async getOrInitProfile(
    rawMachineUid: string,
    defaults: ProfileInitDefaults
  ): Promise<ProfileRowDto> {
    const { hash, key } = await this.resolveBucketKey(rawMachineUid);
    const bucket = this.readBucket(key);

    if (bucket.profile) {
      return normalizeProfileRow(bucket.profile);
    }

    const fixedTag = hash ? `#${hash.slice(0, 10)}` : normalizePeerTag(defaults.peerTag);
    const created: ProfileRowDto = {
      machineHash: hash,
      peerTag: fixedTag,
      nickname: defaults.nickname.trim() || 'Companion',
      avatarUrl: defaults.avatarUrl,
      telemetryConsent: 'unset',
      preferredFps: 60,
      updatedAt: Date.now(),
    };

    this.writeBucket(key, { ...bucket, profile: created });
    return created;
  }

  async updateProfile(
    rawMachineUid: string,
    nickname: string,
    avatarUrl: string,
    preferredFps?: StreamFpsOption
  ): Promise<ProfileRowDto> {
    const { hash, key } = await this.resolveBucketKey(rawMachineUid);
    const bucket = this.readBucket(key);

    if (!bucket.profile) {
      throw new Error(`Profile not initialized for machine hash ${hash}`);
    }

    const updated: ProfileRowDto = {
      ...bucket.profile,
      nickname: nickname.trim() || bucket.profile.nickname,
      avatarUrl: avatarUrl || bucket.profile.avatarUrl,
      preferredFps: preferredFps ?? bucket.profile.preferredFps,
      updatedAt: Date.now(),
    };

    this.writeBucket(key, { ...bucket, profile: updated });
    return updated;
  }

  async setTelemetryConsent(
    rawMachineUid: string,
    consent: TelemetryConsentState
  ): Promise<ProfileRowDto> {
    const { hash, key } = await this.resolveBucketKey(rawMachineUid);
    const bucket = this.readBucket(key);

    if (!bucket.profile) {
      throw new Error(`Profile not initialized for machine hash ${hash}`);
    }

    const updated: ProfileRowDto = {
      ...bucket.profile,
      telemetryConsent: consent,
      updatedAt: Date.now(),
    };

    this.writeBucket(key, { ...bucket, profile: updated });
    return updated;
  }

  async listFriendHubs(): Promise<FriendHubRecordDto[]> {
    const key = await this.resolveActiveKey();
    const bucket = this.readBucket(key);
    return sortHubsByRecent(bucket.friendHubs);
  }

  async upsertFriendHub(hub: FriendHubRecordDto): Promise<FriendHubRecordDto[]> {
    const key = await this.resolveActiveKey();
    const bucket = this.readBucket(key);
    const normalized = normalizeFriendHubRecord(hub);
    const remaining = bucket.friendHubs.filter((item) => item.hubId !== normalized.hubId);
    const nextHubs = sortHubsByRecent([normalized, ...remaining]);
    this.writeBucket(key, { ...bucket, friendHubs: nextHubs });
    return nextHubs;
  }

  async removeFriendHub(hubId: string): Promise<FriendHubRecordDto[]> {
    const key = await this.resolveActiveKey();
    const bucket = this.readBucket(key);
    const nextHubs = sortHubsByRecent(bucket.friendHubs.filter((item) => item.hubId !== hubId));
    this.writeBucket(key, { ...bucket, friendHubs: nextHubs });
    return nextHubs;
  }
}

export const storageRepository: IStorageRepository = isTauri()
  ? new SqliteStorageRepository()
  : new TestFallbackStorageRepository();
