export type KnockStatus = 'idle' | 'knocking' | 'accepted' | 'rejected' | 'timeout';

export interface KnockRequestPayload {
  type: 'knock';
  peerTag: string;       // e.g. "Luna#eGkjL"
  peerIdSafe: string;    // e.g. "Luna_eGkjL"
  displayName: string;   // e.g. "Luna"
  avatarUrl?: string;
  timestamp: number;
}

export interface KnockDecisionPayload {
  type: 'knock_accepted' | 'knock_rejected' | 'answer_accepted' | 'answer_rejected';
  ownerTag?: string;     // e.g. "Mochi#2sintd"
  displayName?: string;  // e.g. "Mochi"
  reason?: string;
  timestamp: number;
}

export interface PendingKnock {
  id: string;
  peerTag: string;
  peerIdSafe: string;
  displayName: string;
  avatarUrl?: string;
  timestamp: number;
  hubTopic: string;
}
