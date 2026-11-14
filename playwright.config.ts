import { defineConfig, devices } from '@playwright/test';

const BASE_URL = 'http://localhost:1420';

const isCiEnv = (): boolean => {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return Boolean(proc?.env?.CI);
};

const WEBRTC_LAUNCH_ARGS = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--enable-webgl',
  '--autoplay-policy=no-user-gesture-required',
];

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  forbidOnly: isCiEnv(),
  retries: isCiEnv() ? 1 : 0,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 12_000,
  },
  reporter: [['list']],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    permissions: ['camera', 'microphone'],
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: WEBRTC_LAUNCH_ARGS,
        },
      },
    },
  ],
  webServer: {
    command: 'bun run dev',
    url: BASE_URL,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
