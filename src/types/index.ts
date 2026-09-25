export type ScreenMode = 'multi-stream' | 'friend-hubs' | 'nickname' | 'left-hub';

export interface AvatarOption {
  id: string;
  name: string;
  label: string;
  url: string;
}

export interface UserProfile {
  nickname: string;
  peerTag: string;
  avatarUrl: string;
  avatarName: string;
}

export interface StreamItem {
  id: string;
  name: string;
  tag: string;
  resolution: string;
  fps: number;
  avatarUrl: string;
  previewImage?: string;
  isLive: boolean;
  volume: number;
  isLocal?: boolean;
  mediaStream?: MediaStream | null;
}

export interface FriendHub {
  id: string;
  name: string;
  status: 'broadcasting' | 'idle';
  description: string;
  previewImage: string;
  peers: number;
  latency: number;
  audioFormat: string;
  spatialStereo?: boolean;
}
