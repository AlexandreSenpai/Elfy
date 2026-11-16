import type { AudioTelemetryDto, StreamFpsOption, StreamResolutionPreset } from './dtos';

/** Baseline empty audio telemetry snapshot when no audio track/stream is active. */
export const EMPTY_AUDIO_TELEMETRY: AudioTelemetryDto = {
  hasAudio: false,
  trackCount: 0,
  codec: '',
  sampleRateHz: 0,
  channels: 0,
  bitrateKbps: 0,
  jitterBufferMs: 0,
  jitterMs: 0,
  packetsLost: 0,
  packetLossPercent: 0,
  audioLevel: null,
};

/** Runtime room capacity and concurrency limits. */
export const ROOM_CONFIG = {
  ENFORCE_MAX_PEERS: true,
  MAX_CONCURRENT_PEERS: 6,
} as const;

/** Supported capture frame rates and resolution presets for screen sharing. */
export const STREAM_FPS_OPTIONS: readonly StreamFpsOption[] = [30, 60, 120];
export const STREAM_RESOLUTION_OPTIONS: readonly StreamResolutionPreset[] = ['720p', '1080p', 'source'];

/** Default screen capture, bitrate budgets, and multi-viewer mesh scaling constants. */
export const STREAM_CONFIG = {
  DEFAULT_FPS: 60 as const,
  FALLBACK_FPS: 30 as const,
  HIGH_FPS: 120 as const,
  DEFAULT_RESOLUTION: '1080p' as StreamResolutionPreset,
  // Preserve native Chromium screenshare pipeline (ContentType::kScreen); forcing 'motion' switches
  // getDisplayMedia() tracks into camera mode and triggers severe FPS drops & resolution downscaling.
  CONTENT_HINT: '' as const,
  RESOLUTION_DIMENSIONS: {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    source: null,
  },
  MAX_BITRATE_BPS: {
    '720p': { 30: 2_500_000, 60: 4_500_000, 120: 6_500_000 },
    '1080p': { 30: 4_500_000, 60: 8_000_000, 120: 12_000_000 },
    source: { 30: 6_000_000, 60: 10_000_000, 120: 15_000_000 },
  },
  MESH_BITRATE_SCALE_BY_VIEWERS: {
    1: 1.0,
    2: 0.78,
    3: 0.62,
    MANY: 0.5,
  },
  MIN_VIDEO_BITRATE_BPS: 1_200_000,
  SDP_BITRATE_START_FACTOR: 0.65,
  SDP_BITRATE_MAX_CEILING_KBPS: 15_000,
} as const;

/** Built-in Google Analytics 4 Measurement Protocol configuration (consent-gated). */
export const TELEMETRY_CONFIG = {
  GA_MEASUREMENT_ID: 'G-ELFY100001',
  GA_API_SECRET: 'elfy-perf-telemetry',
  ENDPOINT: 'https://www.google-analytics.com/mp/collect',
} as const;

/** Signaling broker, WebRTC DataChannel, and local bus channel constants. */
export const SIGNALING_CONFIG = {
  MQTT_BROKER_URL: 'wss://broker.emqx.io:8084/mqtt',
  DATA_CHANNEL_LABEL: 'elfy-control',
  LOCAL_BUS_CHANNEL: 'elfy_local_window_bus',
  TEST_SIGNALING_CHANNEL: 'elfy_test_signaling_bus',
} as const;
