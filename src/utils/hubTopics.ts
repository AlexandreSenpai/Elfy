import { UserProfile } from '../domain/dtos';

const sanitizeToken = (raw: string): string => {
  return (raw || '').trim().replace(/^#/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
};

/**
 * Converts a user's fixed peerTag into a safe MQTT/WebRTC peer identifier.
 * Intentionally ignores the mutable nickname so changing nicknames never breaks
 * active WebRTC streams or MQTT topic routing.
 */
export const toSafePeerTag = (nickname: string, peerTag: string): string => {
  const cleanTag = sanitizeToken(peerTag);
  if (cleanTag) return cleanTag;
  const fallback = (nickname || 'Guest').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  return fallback || 'Guest';
};

/**
 * Formats a user's exchangeable Hub/Peer identifier using ONLY their fixed low-collision ID.
 * E.g., peerTag="#a1b2c3d4e5" -> "#a1b2c3d4e5"
 */
export const formatFullPeerTag = (_nickname: string, peerTag: string): string => {
  const cleanTag = (peerTag || '').trim().replace(/^#/, '');
  return cleanTag ? `#${cleanTag}` : '#000000';
};

/**
 * Normalizes any hub string (e.g. "elfy/hub/#a1b2c3d4e5", "#a1b2c3d4e5", "a1b2c3d4e5",
 * or legacy "elfy/hub/Mochi#a1b2c3d4e5") into the canonical MQTT hub topic base:
 * "elfy/hub/a1b2c3d4e5".
 */
export const normalizeHubTopic = (rawHub: string): string => {
  if (!rawHub || !rawHub.trim() || rawHub === 'elfy/hub/unknown') {
    return '';
  }

  let slug = rawHub.trim().replace(/^\/?(elfy\/hub\/|hub\/)?/, '').replace(/\/+$/, '');
  slug = slug.replace(/\/(knock|probe)$/i, '');

  const hashIndex = slug.lastIndexOf('#');
  if (hashIndex !== -1) {
    const idAfterHash = sanitizeToken(slug.slice(hashIndex + 1));
    if (idAfterHash) {
      return `elfy/hub/${idAfterHash}`;
    }
  }

  const cleanSlug = sanitizeToken(slug);
  return cleanSlug ? `elfy/hub/${cleanSlug}` : '';
};

/**
 * Returns the knock topic for a given hub.
 * E.g., "elfy/hub/Mochi_2sintd/knock"
 */
export const getKnockTopic = (hubInput: string): string => {
  const normalized = normalizeHubTopic(hubInput);
  if (!normalized) return '';
  return `${normalized}/knock`;
};

/**
 * Returns the live discovery probe topic for a given hub.
 * E.g., "elfy/hub/Mochi_2sintd/probe"
 */
export const getProbeTopic = (hubInput: string): string => {
  const normalized = normalizeHubTopic(hubInput);
  if (!normalized) return '';
  return `${normalized}/probe`;
};

/**
 * Returns the direct peer inbox topic for a specific peer within a hub.
 * E.g., "elfy/hub/Mochi_2sintd/peer/Luna_eGkjL"
 */
export const getGuestInboxTopic = (hubInput: string, guestTagSafe: string): string => {
  const normalized = normalizeHubTopic(hubInput);
  if (!normalized) return '';
  const safeGuest = sanitizeToken(guestTagSafe);
  if (!safeGuest) return '';
  return `${normalized}/peer/${safeGuest}`;
};

/**
 * Extracts a human-friendly host display name and fixed tag from a hub topic.
 */
export const extractHostFromHub = (hubInput: string): { displayName: string; tag: string } => {
  const normalized = normalizeHubTopic(hubInput);
  const rawSlug = (hubInput || '').trim().replace(/^\/?(elfy\/hub\/|hub\/)?/, '');
  const hashIdx = rawSlug.lastIndexOf('#');
  if (hashIdx > 0) {
    const legacyName = rawSlug.slice(0, hashIdx).trim();
    const idPart = sanitizeToken(rawSlug.slice(hashIdx + 1));
    if (legacyName && idPart) {
      return { displayName: legacyName, tag: `#${idPart}` };
    }
  }

  const slug = normalized.replace(/^elfy\/hub\//, '');
  const lastUnderscore = slug.lastIndexOf('_');

  if (lastUnderscore > 0) {
    return {
      displayName: slug.substring(0, lastUnderscore),
      tag: `#${slug.substring(lastUnderscore + 1)}`,
    };
  }

  return {
    displayName: 'Hub',
    tag: slug ? `#${slug}` : '',
  };
};

/**
 * Determines whether the given user profile is the owner of the specified hub.
 */
export const isHubOwner = (hubInput: string, profile: UserProfile): boolean => {
  if (!hubInput || !profile) return false;
  const myHubTopic = normalizeHubTopic(`elfy/hub/${toSafePeerTag(profile.nickname, profile.peerTag)}`);
  if (!myHubTopic) return false;
  return normalizeHubTopic(hubInput).toLowerCase() === myHubTopic.toLowerCase();
};
