import { UserProfile } from '../types';

/**
 * Converts a nickname and peerTag into a safe MQTT topic segment.
 * E.g., nickname="Luna", peerTag="#eGkjL" -> "Luna_eGkjL"
 */
export const toSafePeerTag = (nickname: string, peerTag: string): string => {
  const cleanNickname = (nickname || 'Guest').trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  const cleanTag = (peerTag || '').trim().replace(/^#/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${cleanNickname}_${cleanTag}`;
};

/**
 * Formats a user's full display tag.
 * E.g., nickname="Luna", peerTag="#eGkjL" -> "Luna#eGkjL"
 */
export const formatFullPeerTag = (nickname: string, peerTag: string): string => {
  const cleanTag = peerTag.startsWith('#') ? peerTag : `#${peerTag}`;
  return `${nickname}${cleanTag}`;
};

/**
 * Normalizes any hub string (e.g. "Mochi#2sintd", "elfy/hub/Mochi#2sintd", "elfy/hub/Mochi_2sintd")
 * into the canonical MQTT hub topic base: "elfy/hub/Mochi_2sintd".
 */
export const normalizeHubTopic = (rawHub: string): string => {
  if (!rawHub) return 'elfy/hub/unknown';
  let cleaned = rawHub.trim().replace(/#/g, '_');
  if (!cleaned.startsWith('elfy/hub/')) {
    // If it started with / or hub/, strip first
    cleaned = cleaned.replace(/^\/?(elfy\/hub\/|hub\/)?/, '');
    cleaned = `elfy/hub/${cleaned}`;
  }
  return cleaned.replace(/\/+$/, '');
};

/**
 * Returns the knock topic for a given hub.
 * E.g., "elfy/hub/Mochi_2sintd/knock"
 */
export const getKnockTopic = (hubInput: string): string => {
  return `${normalizeHubTopic(hubInput)}/knock`;
};

/**
 * Returns the direct peer inbox topic for a specific guest within a hub.
 * E.g., "elfy/hub/Mochi_2sintd/peer/Luna_eGkjL"
 */
export const getGuestInboxTopic = (hubInput: string, guestTagSafe: string): string => {
  const safeGuest = guestTagSafe.replace(/#/g, '_').trim();
  return `${normalizeHubTopic(hubInput)}/peer/${safeGuest}`;
};

/**
 * Extracts a human-friendly host display name and tag from a hub topic.
 * E.g., "elfy/hub/Mochi_2sintd" -> { displayName: "Mochi", tag: "#2sintd" }
 */
export const extractHostFromHub = (hubInput: string): { displayName: string; tag: string } => {
  const normalized = normalizeHubTopic(hubInput);
  const slug = normalized.replace(/^elfy\/hub\//, '');
  const lastUnderscore = slug.lastIndexOf('_');
  if (lastUnderscore !== -1) {
    return {
      displayName: slug.substring(0, lastUnderscore),
      tag: `#${slug.substring(lastUnderscore + 1)}`
    };
  }
  return {
    displayName: slug || 'Host',
    tag: ''
  };
};

/**
 * Determines whether the given user profile is the owner of the specified hub.
 */
export const isHubOwner = (hubInput: string, profile: UserProfile): boolean => {
  if (!hubInput || !profile) return false;
  const myHubTopic = normalizeHubTopic(`elfy/hub/${toSafePeerTag(profile.nickname, profile.peerTag)}`);
  return normalizeHubTopic(hubInput).toLowerCase() === myHubTopic.toLowerCase();
};
