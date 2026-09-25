import { AvatarOption, FriendHub, StreamItem, UserProfile } from '../types';

export const ELFY_MASCOT_ICON = 'elfy-dock.png';
export const ELFY_HAPPY = "elfy-happy.png";

export const AVATAR_OPTIONS: AvatarOption[] = [
  {
    id: 'wink',
    name: 'Winking Elf',
    label: 'Wink',
    url: 'avatar_01_sunny.png'
  },
  {
    id: 'happy',
    name: 'Joyful Elf',
    label: 'Happy',
    url: 'avatar_02_library.png'
  },
  {
    id: 'sleepy',
    name: 'Cozy Snooze',
    label: 'Sleepy',
    url: 'avatar_03_red.png'
  },
  {
    id: 'mono',
    name: 'Shadow Invert',
    label: 'Mono',
    url: 'avatar_04_sleepy.png'
  },
  {
    id: 'pop',
    name: 'Coral Pop',
    label: 'Pop',
    url: 'avatar_06_pink.png'
  }
];

export const DEFAULT_USER_PROFILE: UserProfile = {
  nickname: 'Pip',
  peerTag: '#4092',
  avatarUrl: "avatar_07_closeup.png",
  avatarName: 'Winking Elf'
};

export const CUTE_ALIASES = [
  'Pip', 'Nova', 'Bramble', 'Mochi', 'Sylph', 'PixelElf',
  'ChibiKitsune', 'Luna', 'Fern', 'Echo', 'TauriRider', 'Velvet',
  'Sprout', 'Komorebi', 'Starling', 'Willow'
];

export const INITIAL_STREAMS: StreamItem[] = [
  {
    id: 'stream-1',
    name: "Bramble's Screen",
    tag: 'Unreal Engine',
    resolution: '1080p',
    fps: 60,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBaSyrQsD44Dc3VmL5IxW3fIGlePGGQgaxZVYFRvsVeRm3_o_2x0GQQsOwYRX0akKezYfLkzXCNpGxIVHaPFEOMYLXldCzpH6te8MMsvs8NqM4ktsbibiy4hIRYEKMdkgnzxa7gKeFMH2_h1PtAasJ0ZyCaXClwhg0R9fDmYKipJZCcZglw-ZHxJod_wUZdrvJLmGo19vKSZNKa2VzhamjtNU8xRVrJpWmw6PIowhEuHeZ9dgedlqC9GQ',
    previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAwrCWwKw-W0rvU7MAL4V6Kj456hGoZR8PW65JK00aP5y2MR_L64TbjIdJ2BafmQhbygdYu69Xyyb2VAhvcVAidjnPCaWphLQhT0Q-Rrt68T4d9ip2z5imkLeT6jc9wbnvcuw-ehVLL4Ln6uDVmU0ZjxQaeCx6g7vgaTTNxRLLJU9FGo1eGGlPvWN1hfqDE7qeoCF0cJ5k2GMd2m7K-wxiTOsea3G3fwvJGI1kcbL-hdd41lwwB1f7-Qg',
    isLive: true,
    volume: 85
  },
  {
    id: 'stream-2',
    name: "Nova's Screen",
    tag: 'Rust & Shaders',
    resolution: '1440p',
    fps: 60,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuBVU-OQt6XgPPBUneTOAdXK-mfSsyUaltN66Qi0vkjixpEoWQ-8tLfKjy9fsrvmaacwj3Uey9tPOAIIS0IIdIegDN1V2it11sBXukq3PikBRINGawERb1Swgc5m2F2XwvOuvDVpSrZSxYjsjObN4e9XfW7n8XLS0p_u2EWRhZ0_u2dXrkax7u9E3x1MfZJiNgqgE3MRQj1aKUYchxGyBneEECbk4DDRicsnudyOga-vNE7Qdk23a-uTrw',
    previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCCjYufkLLSjpZ-AlKtGq_AaUtIZiTZ-Alvg67A-V_06a5UijPTJwJ10QYDry2L3x8aDFq5MqHnHZzBGdz3_RACB067EpuLyvUpvHQFGzUsjEUCISZi3OcSoxiG2A8n_jNVyWefb6HRZkf4kJ5RK1tv6KydAC-86Ap-Zd8BSNVC2GGROLMBz0qb1I-2xzlmhLHvsliKboWUXUvWDMy4HVcCHCyp_dWG7bqTa2PzctuO3NQwl7SEtK0SKg',
    isLive: true,
    volume: 90
  },
  {
    id: 'stream-3',
    name: "Pip's Cam",
    tag: 'Desk Cam',
    resolution: '1080p',
    fps: 30,
    avatarUrl: 'https://lh3.googleusercontent.com/aida-public/AB6AXuAoquxTFmipoqldwyCVFRvhMQbQPZY0zaBKnhk6xrEK_vM7PRbrkLo3M52XKti08grTSM-zoeiMMtVywRy6iTrJwq4GmV5ISfHiLTAMXUXv-KWfWwMSKdrqkKe_6l9cmhJ6J-7AP0NhhFmbPENylFt36iAoEN-H28GDTwo1-qVWhEDlBeCkdWZ2etIN8EOqd6Wg_w1S2wzUWKm2UYD5Llm7fIaYyYSqsd2SkhtaA4CxntQqbi0U1BWd-g',
    previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCrldQPGzxxh09xENnOFCZViQRSRflFO60Ruipnql8fk1lnROZmJjE7O5miK5aKPBVsvqj0OUASiINBlb72R_ttKAD3JT8JtCjo-_TB8L2SNoqgeJmWjB4Ss-BG8K9XXTDnNsWGddovspcZ-eFNNF8yX7DPCL04_aKzqNIKpBWOlUTx0HsJbYhmdmNsmX37SpNc7F2geLBdYNTl_9CIUdKvVnhvrkpBQsbNvrbVsRik4bOmmLi_MlGPiA',
    isLive: true,
    volume: 70
  }
];

export const INITIAL_FRIEND_HUBS: FriendHub[] = [
  {
    id: 'treehouse',
    name: 'The Treehouse Lounge',
    status: 'broadcasting',
    description: 'Pip, Bramble, Nova & 2 others watching · Live Game',
    previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuDkFcG59_niCuFb9mf6LKxPlbkj6w_Oc7I8NYt4EWON7_6tuglmcdw9PH0n-WWOrn4h8r3eh39FTCsQlZlTdJa7QrAWvGo331nJFe_OVSlPJ1s4Kd1ZX-6xunZLRqnz96SI8PaadXlqcqe_kxT_cuzokBcxEiuzGWma1pO9I48snpTUOXSESK55uOG0QqQ8fF_rHNs9IilfiXMoFp8avKNHIGJ1XrGae7Alfig0kQSSk-pkNAcvKXLOTA',
    peers: 5,
    latency: 16,
    audioFormat: 'Spatial Stereo',
    spatialStereo: true
  },
  {
    id: 'design-jam',
    name: 'Design & Jam Pod',
    status: 'idle',
    description: '2 friends idling · Figma + Lo-Fi Session',
    previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuB4ADxW8ZnRZzNLCb1Y8iSB01mH-LJbcbQQw_sMRjD-q3nimRXiRmnNqdePhnrO_Hb9RNZXKD3DCVoQ4VRD3HDoEIrARON2pAPJu8Z5rQjW3lHApg0jWzNXMn0DEfheG_JTfFm4SuAexfX_BwVCy-OxRGjrq4M5WPmXi3N4zXtVCqFnZsWENgtAX7B5gyiTw-IbaAz9QAAMJUKPf5t5DMkm5vZ-jjWs3JGfw8yj5TMl18i0UtRCBv2HVw',
    peers: 2,
    latency: 22,
    audioFormat: 'Stereo 48kHz'
  },
  {
    id: 'movie-den',
    name: 'Late Night Movie Den',
    status: 'idle',
    description: '3 friends chilling · Muted mic mode active',
    previewImage: 'https://lh3.googleusercontent.com/aida-public/AB6AXuCT0GjJCF5HLvTYiR_5HztKRsWKH6ItbWBDnq9zkGXoVK6xWSP1OjQZLwZxPDT0osoqQbCGKSxyobnx9I7xOKdA7-wwVwzyUDBAx3nHeEiBQBQfaLPLeyiDYP1uxh6JxQagHp8bEuFgfsyZr6y1IaOonQ4i_3vlenIqXwKoXs5ieKZ_VAnGPkGfWI6hu0N3lkommNoQMHapB1Ql_ZxdAtEzLryKnI-S9pdhCL1jyT5R3Fd8v8PS_SrQqw',
    peers: 3,
    latency: 28,
    audioFormat: 'Dolby 5.1 Virtual'
  }
];
