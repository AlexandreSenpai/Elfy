/** Runtime room capacity and concurrency limits. */
export const ROOM_CONFIG = {
  ENFORCE_MAX_PEERS: true,
  MAX_CONCURRENT_PEERS: 6,
} as const;

/** Default screen capture and playback stream parameters. */
export const STREAM_CONFIG = {
  DEFAULT_FPS: 60 as const,
  FALLBACK_FPS: 30 as const,
  DEFAULT_RESOLUTION: '1080p',
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
