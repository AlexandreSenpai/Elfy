import { AvatarOption, UserProfile } from '../types';

export const ELFY_MASCOT_ICON = 'elfy-dock.png';
export const ELFY_HAPPY = 'elfy-happy.png';

export const AVATAR_OPTIONS: AvatarOption[] = [
  {
    id: 'wink',
    name: 'Winking Elf',
    label: 'Wink',
    url: 'avatar_01_sunny.png',
  },
  {
    id: 'happy',
    name: 'Joyful Elf',
    label: 'Happy',
    url: 'avatar_02_library.png',
  },
  {
    id: 'sleepy',
    name: 'Cozy Snooze',
    label: 'Sleepy',
    url: 'avatar_03_red.png',
  },
  {
    id: 'mono',
    name: 'Shadow Invert',
    label: 'Mono',
    url: 'avatar_04_sleepy.png',
  },
  {
    id: 'pop',
    name: 'Coral Pop',
    label: 'Pop',
    url: 'avatar_06_pink.png',
  },
];

export const DEFAULT_USER_PROFILE: UserProfile = {
  nickname: 'Pip',
  peerTag: '#4092',
  avatarUrl: 'avatar_07_closeup.png',
  avatarName: 'Winking Elf',
  telemetryConsent: 'unset',
  preferredFps: 60,
};

export const CUTE_ALIASES = [
  'Pip', 'Nova', 'Bramble', 'Mochi', 'Sylph', 'PixelElf',
  'ChibiKitsune', 'Luna', 'Fern', 'Echo', 'TauriRider', 'Velvet',
  'Sprout', 'Komorebi', 'Starling', 'Willow',
];
