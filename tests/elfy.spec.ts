import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

interface RecordedTelemetryEvent {
  name: string;
  params: Record<string, unknown>;
  timestamp: number;
}

interface PeerSession {
  page: Page;
  uid: string;
  hubCode: string;
}

interface TrackTelemetrySnapshot {
  videoCount: number;
  liveTracks: number;
  frameRates: number[];
  constrainedFps: number[];
  readyStates: number[];
  widths: number[];
}

const activeContexts: BrowserContext[] = [];

const createRunUid = (prefix: string): string => {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}-${Date.now()}-${rand}`;
};

const createTrackedContext = async (browser: Browser): Promise<BrowserContext> => {
  const context = await browser.newContext();
  activeContexts.push(context);
  return context;
};

const initPeerPage = async (context: BrowserContext, uid: string): Promise<Page> => {
  const page = await context.newPage();
  await page.addInitScript((machineUid: string) => {
    sessionStorage.setItem('elfy_test_machine_uid', machineUid);
    const win = window as unknown as { __ELFY_FORCE_SYNTHETIC_STREAM__?: boolean };
    win.__ELFY_FORCE_SYNTHETIC_STREAM__ = true;
  }, uid);
  return page;
};

const openHomeAndSetConsent = async (
  page: Page,
  consent: 'agree' | 'decline'
): Promise<void> => {
  await page.goto('/#/');
  const modal = page.getByTestId('telemetry-consent-modal');
  await expect(modal).toBeVisible();
  const btnId = consent === 'agree' ? 'telemetry-agree-btn' : 'telemetry-decline-btn';
  await page.getByTestId(btnId).click();
  await expect(modal).toBeHidden();
};

const clickAndResolveDestinationPage = async (
  page: Page,
  trigger: () => Promise<void>
): Promise<Page> => {
  const popupPromise = page.waitForEvent('popup', { timeout: 1500 }).catch(() => null);
  await trigger();
  const popup = await popupPromise;
  if (!popup) return page;
  await popup.waitForLoadState('domcontentloaded');
  return popup;
};

const readMyHubCode = async (page: Page): Promise<string> => {
  const codeText = (await page.getByTestId('my-hub-code').innerText()).trim();
  if (!codeText) {
    throw new Error('Expected non-empty my-hub-code');
  }
  return codeText;
};

const extractPeerTag = (hubCode: string): string => {
  const match = hubCode.match(/(#[A-Za-z0-9_-]+)/);
  if (match) return match[1];
  const underscoreIdx = hubCode.lastIndexOf('_');
  if (underscoreIdx === -1) return '';
  return `#${hubCode.slice(underscoreIdx + 1)}`;
};

const openOwnerRoom = async (ownerPage: Page): Promise<Page> => {
  const roomPage = await clickAndResolveDestinationPage(ownerPage, async () => {
    await ownerPage.getByTestId('open-my-hub-btn').click();
  });
  await expect(roomPage.getByTestId('multi-stream-hub')).toBeVisible();
  return roomPage;
};

const knockGuestIntoHub = async (guestPage: Page, hubCode: string): Promise<Page> => {
  await guestPage.getByTestId('join-hub-input').fill(hubCode);
  const guestRoomPage = await clickAndResolveDestinationPage(guestPage, async () => {
    await guestPage.getByTestId('join-hub-submit').click();
  });
  await expect(guestRoomPage.getByTestId('guest-knock-gate')).toBeVisible();
  return guestRoomPage;
};

const admitGuestToOwnerHub = async (
  context: BrowserContext,
  prefix: string
): Promise<{
  owner: PeerSession;
  guest: PeerSession;
  ownerRoom: Page;
  guestRoom: Page;
}> => {
  const ownerUid = createRunUid(`${prefix}-owner`);
  const guestUid = createRunUid(`${prefix}-guest`);

  const ownerPage = await initPeerPage(context, ownerUid);
  await openHomeAndSetConsent(ownerPage, 'decline');
  const ownerHubCode = await readMyHubCode(ownerPage);

  const guestPage = await initPeerPage(context, guestUid);
  await openHomeAndSetConsent(guestPage, 'decline');
  const guestHubCode = await readMyHubCode(guestPage);

  const ownerRoom = await openOwnerRoom(ownerPage);
  const guestRoom = await knockGuestIntoHub(guestPage, ownerHubCode);

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();

  return {
    owner: { page: ownerPage, uid: ownerUid, hubCode: ownerHubCode },
    guest: { page: guestPage, uid: guestUid, hubCode: guestHubCode },
    ownerRoom,
    guestRoom,
  };
};

const readVideoSnapshot = async (page: Page): Promise<TrackTelemetrySnapshot> => {
  return page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('video'));
    const tracks = videos.flatMap((video) => {
      return video.srcObject instanceof MediaStream ? video.srcObject.getVideoTracks() : [];
    });

    const constrainedFps = tracks
      .map((track) => {
        const rate = track.getConstraints().frameRate;
        if (typeof rate === 'number') return rate;
        if (rate && typeof rate === 'object') return rate.ideal ?? rate.max;
        return undefined;
      })
      .filter((fps): fps is number => typeof fps === 'number');

    return {
      videoCount: videos.length,
      liveTracks: tracks.filter((track) => track.readyState === 'live').length,
      frameRates: tracks
        .map((track) => track.getSettings().frameRate)
        .filter((fps): fps is number => typeof fps === 'number'),
      constrainedFps,
      readyStates: videos.map((video) => video.readyState),
      widths: videos.map((video) => video.videoWidth),
    };
  });
};

const isPlaybackHealthy = async (page: Page, expectedMinVideos: number): Promise<boolean> => {
  const snap = await readVideoSnapshot(page);
  if (snap.videoCount < expectedMinVideos || snap.liveTracks < expectedMinVideos) return false;
  if (!snap.readyStates.every((state) => state >= 2)) return false;
  return snap.widths.every((width) => width > 0);
};

const waitForContinuousPlayback = async (
  page: Page,
  expectedMinVideos: number,
  durationMs: number
): Promise<void> => {
  await expect
    .poll(() => isPlaybackHealthy(page, expectedMinVideos), { timeout: 15_000 })
    .toBe(true);

  const startedAt = Date.now();
  while (Date.now() - startedAt < durationMs) {
    await page.waitForTimeout(300);
    expect(await isPlaybackHealthy(page, expectedMinVideos)).toBe(true);
  }
};

const readTelemetryEvents = async (page: Page): Promise<RecordedTelemetryEvent[]> => {
  return page.evaluate(() => {
    const win = window as unknown as { __ELFY_TELEMETRY_EVENTS__?: RecordedTelemetryEvent[] };
    return win.__ELFY_TELEMETRY_EVENTS__ ?? [];
  });
};

const assertNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const overflowPx = await page.evaluate(() => {
    return document.documentElement.scrollWidth - window.innerWidth;
  });
  expect(overflowPx).toBeLessThanOrEqual(1);
};

const enterFullscreenViewer = async (roomPage: Page): Promise<void> => {
  const spotlight = roomPage.getByTestId('streams-spotlight');
  const fullscreenBtn = spotlight.getByTestId('enter-fullscreen-btn').first();

  if ((await fullscreenBtn.count()) > 0) {
    await fullscreenBtn.click();
    return;
  }

  await roomPage.getByTestId('stream-tile').first().dblclick();
};

const instrumentBroadcastProbeCapture = async (page: Page): Promise<void> => {
  await page.evaluate(() => {
    const win = window as unknown as {
      __ELFY_PROBE_SENT__?: string[];
      __ELFY_PROBE_PATCHED__?: boolean;
    };
    win.__ELFY_PROBE_SENT__ = [];
    if (win.__ELFY_PROBE_PATCHED__) return;
    win.__ELFY_PROBE_PATCHED__ = true;

    const origPost = BroadcastChannel.prototype.postMessage;
    BroadcastChannel.prototype.postMessage = function (data: unknown) {
      const payload = (data as { envelope?: { payload?: { type?: string } } })?.envelope?.payload;
      if (payload?.type === 'hub_status_request') {
        win.__ELFY_PROBE_SENT__?.push('hub_status_request');
      }
      return origPost.call(this, data);
    };
  });
};

const readObservedTrackFps = async (page: Page): Promise<number> => {
  const snap = await readVideoSnapshot(page);
  if (snap.constrainedFps.length > 0) return snap.constrainedFps[0];
  return snap.frameRates[0] ?? 0;
};

const waitForSavedFriendHub = async (page: Page, ownerTag: string): Promise<void> => {
  const cleanTag = ownerTag.replace(/^#/, '');
  await expect
    .poll(async () => {
      return page.evaluate((tag: string) => {
        for (let i = 0; i < localStorage.length; i += 1) {
          const key = localStorage.key(i);
          if (!key || !key.startsWith('elfy_test_db_')) continue;
          const raw = localStorage.getItem(key) ?? '';
          if (raw.includes(tag) && raw.includes('"friendHubs":[{')) return true;
        }
        return false;
      }, cleanTag);
    })
    .toBe(true);
};

test.afterEach(async () => {
  while (activeContexts.length > 0) {
    const context = activeContexts.pop();
    if (context) await context.close();
  }
});

test('Test 1 — Telemetry Consent Alert & Opt-Out/Opt-In Gating', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const page = await initPeerPage(context, createRunUid('t1'));

  const gaRequests: string[] = [];
  await page.route('https://www.google-analytics.com/mp/collect**', async (route) => {
    gaRequests.push(route.request().postData() ?? '');
    await route.fulfill({ status: 204, body: '' });
  });

  await openHomeAndSetConsent(page, 'decline');
  const deniedRoom = await openOwnerRoom(page);
  await expect.poll(() => readTelemetryEvents(deniedRoom)).toEqual([]);
  expect(gaRequests).toHaveLength(0);

  if (deniedRoom !== page) await deniedRoom.close();
  await page.reload();
  await expect(page.getByTestId('telemetry-consent-modal')).toBeHidden();

  await page.goto('/#/register');
  const toggle = page.getByTestId('telemetry-toggle');
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  await page.getByRole('button', { name: /save changes|get started/i }).click();
  await expect(page.getByTestId('my-hub-code')).toBeVisible();

  const optedInRoom = await openOwnerRoom(page);
  await optedInRoom.getByTestId('toggle-share-btn').click();
  await optedInRoom.getByTestId('stream-settings-btn').click();
  await expect(optedInRoom.getByTestId('stream-settings-popover')).toBeVisible();
  await optedInRoom.getByTestId('settings-fps-30').click();
  await optedInRoom.keyboard.press('Escape');
  await expect(optedInRoom.getByTestId('stream-settings-popover')).toBeHidden();

  await expect.poll(async () => (await readTelemetryEvents(optedInRoom)).length).toBeGreaterThan(0);
  await expect.poll(() => gaRequests.length).toBeGreaterThan(0);
  const recorded = await readTelemetryEvents(optedInRoom);
  const serialized = JSON.stringify(recorded);
  expect(serialized).not.toContain('elfy/hub/');
  expect(serialized).not.toContain('t1-');
});

test('Test 2 — Machine Fingerprint Lock & Single Hub per User', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const page = await initPeerPage(context, createRunUid('t2-locked'));
  await openHomeAndSetConsent(page, 'decline');

  const initialHubCode = await readMyHubCode(page);
  const initialTag = extractPeerTag(initialHubCode);
  expect(initialTag).not.toBe('');
  expect(initialHubCode).toBe(`elfy/hub/${initialTag}`);

  await page.getByRole('button', { name: /edit persona/i }).click();
  await expect(page).toHaveURL(/#\/register$/);
  await expect(page.getByRole('heading', { name: /update your profile/i })).toBeVisible();
  await expect(page.getByTestId('locked-peer-tag')).toContainText(initialTag);
  await page.getByRole('button', { name: /happy/i }).click();
  await page.locator('input[type="text"]').first().fill('NovaFox');
  await page.getByRole('button', { name: /save changes|get started/i }).click();

  await expect(page.getByTestId('my-hub-code')).toHaveText(`elfy/hub/${initialTag}`);
  await expect(page.getByTestId('my-hub-code')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('my-hub-code')).toHaveText(`elfy/hub/${initialTag}`);

  await page.goto('/#/register');
  await expect(page.getByTestId('locked-peer-tag')).toContainText(initialTag);
  await page.getByRole('button', { name: /sleepy/i }).click();
  await page.locator('input[type="text"]').first().fill('PixelMochi');
  await page.getByRole('button', { name: /save changes|get started/i }).click();

  await expect(page.getByTestId('my-hub-code')).toHaveText(`elfy/hub/${initialTag}`);
  await expect(page.getByTestId('my-hub-code')).toHaveCount(1);

  // Verify changing nickname while actively sharing screen does not break stream or hub routing
  const { ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't2-live');
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 800);

  await ownerRoom.getByRole('button', { name: /edit persona/i }).click();
  await ownerRoom.locator('input[type="text"]').first().fill('LiveRenamedHost');
  await ownerRoom.getByRole('button', { name: /save changes|get started/i }).click();

  await expect(guestRoom.getByTestId('stream-tile').first()).toContainText('LiveRenamedHost');
  await ownerRoom.getByTestId('toggle-self-preview-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText('LiveRenamedHost');
  await waitForContinuousPlayback(guestRoom, 1, 800);
});

test('Test 3 — Knock-to-Enter Gate & Automatic Friend Hub Saving', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { owner, guest, ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't3');
  const ownerTag = extractPeerTag(owner.hubCode);

  const knockAlertStats = await ownerRoom.evaluate(() => {
    const win = window as unknown as {
      __ELFY_KNOCK_SOUNDS_PLAYED__?: number;
      __ELFY_NOTIFICATIONS_SHOWN__?: Array<{ title: string; body: string }>;
    };
    return {
      soundsPlayed: win.__ELFY_KNOCK_SOUNDS_PLAYED__ ?? 0,
      notificationsShown: (win.__ELFY_NOTIFICATIONS_SHOWN__ ?? []).length,
    };
  });
  expect(knockAlertStats.soundsPlayed).toBeGreaterThanOrEqual(1);
  expect(knockAlertStats.notificationsShown).toBeGreaterThanOrEqual(1);

  await waitForSavedFriendHub(guestRoom, ownerTag);
  await guestRoom.goto('/#/');
  await expect(guest.page.getByTestId('friend-hubs-list')).toBeVisible();
  await expect(guest.page.getByTestId('friend-hub-card').first()).toContainText(ownerTag);
});

test('Test 4 — Bidirectional Streaming Stability & Grid/Spotlight/Fullscreen', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't4');

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(0);
  await waitForContinuousPlayback(guestRoom, 1, 1200);

  await guestRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('streams-grid')).toBeVisible();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(1);
  await expect(guestRoom.getByTestId('stream-tile')).toHaveCount(1);
  await waitForContinuousPlayback(ownerRoom, 1, 800);

  await ownerRoom.getByTestId('stream-settings-btn').click();
  await expect(ownerRoom.getByTestId('stream-settings-popover')).toBeVisible();
  await ownerRoom.getByTestId('dock-self-preview-btn').click();
  await ownerRoom.keyboard.press('Escape');
  await expect(ownerRoom.getByTestId('stream-settings-popover')).toBeHidden();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(2);
  await waitForContinuousPlayback(ownerRoom, 2, 600);

  await ownerRoom.getByTestId('layout-mode-spotlight').click();
  await expect(ownerRoom.getByTestId('streams-spotlight')).toBeVisible();

  await enterFullscreenViewer(ownerRoom);
  await expect(ownerRoom.getByTestId('fullscreen-stream-viewer')).toBeVisible();
  await ownerRoom.keyboard.press('Escape');
  await expect(ownerRoom.getByTestId('fullscreen-stream-viewer')).toBeHidden();
});

test('Test 5 — 30/60/120 FPS, Resolution Presets, Self-Preview Toggle & Floating Settings / Telemetry', async ({
  browser,
}) => {
  const context = await createTrackedContext(browser);
  const { ownerRoom } = await admitGuestToOwnerHub(context, 't5');

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('encoder-status-pill')).toBeVisible();

  // Verify Topbar and BottomDock removals
  const header = ownerRoom.locator('header');
  await expect(header).not.toContainText('Connected');
  await expect(header).not.toContainText(/Stream(s)? Active/i);
  await expect(header.getByRole('button', { name: /minimize hub companion/i })).toHaveCount(0);
  await expect(ownerRoom.getByTestId('toggle-telemetry-panel-btn')).toHaveCount(0);

  const bottomDock = ownerRoom.getByTestId('bottom-dock');
  await expect(ownerRoom.getByTestId('system-metrics-badge')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('minimize-hub-btn')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('layout-toggle-btn')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('fps-toggle-btn')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('resolution-toggle-btn')).toHaveCount(0);
  await expect(bottomDock.locator('select')).toHaveCount(0);

  // Opt-in to local self-preview and verify floating settings popover updates FPS & resolution
  await ownerRoom.getByTestId('toggle-self-preview-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(1);

  const settingsBtn = ownerRoom.getByTestId('stream-settings-btn');
  const settingsPopover = ownerRoom.getByTestId('stream-settings-popover');
  await expect(settingsBtn).toContainText(/1080p\s*·\s*60\s*FPS/i);
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText(/60\s*fps/i);

  await settingsBtn.click();
  await expect(settingsBtn).toHaveAttribute('aria-expanded', 'true');
  await expect(settingsPopover).toBeVisible();
  await expect(bottomDock.locator('select')).toHaveCount(0);

  await ownerRoom.getByTestId('settings-fps-30').click();
  await expect(settingsBtn).toContainText(/30\s*FPS/i);
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText(/30\s*fps/i);
  await expect.poll(() => readObservedTrackFps(ownerRoom)).toBe(30);

  await ownerRoom.getByTestId('settings-fps-120').click();
  await expect(settingsBtn).toContainText(/120\s*FPS/i);
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText(/120\s*fps/i);
  await expect.poll(() => readObservedTrackFps(ownerRoom)).toBe(120);

  await ownerRoom.getByTestId('settings-resolution-720p').click();
  await expect(settingsBtn).toContainText(/720p/i);
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText(/720p/i);

  await ownerRoom.getByTestId('settings-resolution-source').click();
  await expect(settingsBtn).toContainText(/Native/i);

  // Turning self-preview off returns to lightweight live broadcast card without stopping capture
  await ownerRoom.getByTestId('dock-self-preview-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();

  // Clicking outside closes the floating settings popover; Escape also closes it cleanly
  await ownerRoom.getByRole('heading', { name: /you are live/i }).click();
  await expect(settingsPopover).toBeHidden();
  await expect(settingsBtn).toHaveAttribute('aria-expanded', 'false');

  await settingsBtn.click();
  await expect(settingsPopover).toBeVisible();
  await ownerRoom.keyboard.press('Escape');
  await expect(settingsPopover).toBeHidden();

  // Verify real browser CPU/RAM/FPS telemetry and honest NO AUDIO state via host card in Participants
  await ownerRoom.getByTestId('toggle-participants-panel-btn').click();
  const participantsPanel = ownerRoom.getByTestId('participants-panel');
  await expect(participantsPanel).toBeVisible();
  await participantsPanel.locator('[data-testid="peer-telemetry-btn"]:not([disabled])').first().click();

  const telemetryPanel = ownerRoom.getByTestId('telemetry-panel');
  await expect(telemetryPanel).toBeVisible();
  await expect(telemetryPanel.getByTestId('telemetry-device-card')).toContainText(
    /(?:OS CPU|UI Thread)\s*\(\d+T\)\s*\d+%/i
  );
  await expect(telemetryPanel.getByTestId('telemetry-device-card')).toContainText(
    /(?:System RAM|JS Heap).*(?:\d+\s*MB|\d+\.\d+\s*\/\s*\d+\.\d+\s*GB)/i
  );
  await expect(telemetryPanel.getByTestId('telemetry-fps-chart')).toContainText(/Target:\s*120\s*FPS/i);
  const audioCard = telemetryPanel.getByTestId('telemetry-audio-card');
  await expect(audioCard).toContainText(/NO AUDIO/i);
  await expect(audioCard).toContainText(/Video Only Stream/i);
  await expect(audioCard).not.toContainText(/Opus Stereo/i);
  await expect(audioCard).not.toContainText(/48kHz/i);
});

test('Test 6 — Minimize Active Hub Without Exiting', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { owner, ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't6');

  const ownerCompanionHome = await initPeerPage(context, owner.uid);
  await ownerCompanionHome.goto('/#/');
  await expect(ownerCompanionHome.getByTestId('my-hub-code')).toBeVisible();

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 600);

  await ownerRoom.getByTestId('minimize-window-btn').click();
  await expect(ownerRoom.getByTestId('watch-room-minimized-bar')).toBeVisible();
  await expect(ownerCompanionHome.getByTestId('minimized-hub-banner')).toBeVisible();

  await waitForContinuousPlayback(guestRoom, 1, 800);

  await ownerRoom.getByTestId('restore-watch-room-btn').click();
  await expect(ownerRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await expect(ownerCompanionHome.getByTestId('minimized-hub-banner')).toBeHidden();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();
  await ownerRoom.getByTestId('toggle-self-preview-btn').click();
  await waitForContinuousPlayback(ownerRoom, 1, 600);
});

test('Test 7 — Friend Hubs Live Discovery Probing', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { owner, guest, ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't7');
  const ownerTag = extractPeerTag(owner.hubCode);

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 500);
  await waitForSavedFriendHub(guestRoom, ownerTag);

  if (guestRoom !== guest.page) await guestRoom.close();
  await guest.page.goto('/#/');
  await expect(guest.page.getByTestId('friend-hub-card').first()).toBeVisible();

  const refreshBtn = guest.page.getByTestId('refresh-hubs-btn');
  await expect(refreshBtn).toBeEnabled();
  await instrumentBroadcastProbeCapture(guest.page);
  await refreshBtn.click();

  await expect
    .poll(async () => {
      return guest.page.evaluate(() => {
        const win = window as unknown as { __ELFY_PROBE_SENT__?: string[] };
        return (win.__ELFY_PROBE_SENT__ ?? []).length;
      });
    })
    .toBeGreaterThan(0);

  const card = guest.page.getByTestId('friend-hub-card').filter({ hasText: ownerTag }).first();
  await expect(card).toContainText(/broadcasting/i);
  await expect(card.getByTestId('hub-peer-count')).toContainText(/[1-9]/);
});

test('Test 8 — Responsive Viewport Layout', async ({ browser }) => {
  const viewports = [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 360, height: 580 },
  ];

  const context = await createTrackedContext(browser);
  const page = await initPeerPage(context, createRunUid('t8'));
  await openHomeAndSetConsent(page, 'decline');

  for (const vp of viewports) {
    await page.setViewportSize(vp);
    await expect(page.getByTestId('my-hub-code')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  }

  const roomPage = await openOwnerRoom(page);
  await roomPage.getByTestId('toggle-share-btn').click();

  for (const vp of viewports) {
    await roomPage.setViewportSize(vp);
    await expect(roomPage.getByTestId('multi-stream-hub')).toBeVisible();
    await expect(roomPage.getByTestId('bottom-dock')).toBeVisible();
    await assertNoHorizontalOverflow(roomPage);
  }
});

test('Test 9 — Host Pre-Shares Before Guest Knocks & Re-Share Recovery', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const ownerUid = createRunUid('t9-owner');
  const guestUid = createRunUid('t9-guest');

  const ownerPage = await initPeerPage(context, ownerUid);
  await openHomeAndSetConsent(ownerPage, 'decline');
  const ownerHubCode = await readMyHubCode(ownerPage);

  const guestPage = await initPeerPage(context, guestUid);
  await openHomeAndSetConsent(guestPage, 'decline');

  const ownerRoom = await openOwnerRoom(ownerPage);
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();

  const guestRoom = await knockGuestIntoHub(guestPage, ownerHubCode);
  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 1400);

  await guestRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(1);
  await waitForContinuousPlayback(ownerRoom, 1, 600);

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(guestRoom.getByTestId('stream-tile')).toHaveCount(0);
  await expect(guestRoom.getByTestId('local-stream-hidden-card')).toBeVisible();
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(guestRoom.getByTestId('stream-tile')).toHaveCount(1);
  await waitForContinuousPlayback(guestRoom, 1, 600);
});

test('Test 10 — Room Exit and Re-Entry / Re-Connection Stability', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await createTrackedContext(browser);
  const { owner, ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't10');

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 800);

  // Exact scenario: Host keeps sharing -> Guest leaves (directly returns to Friend Hubs) -> clicks Watch -> knocks -> accepted.
  await guestRoom.getByTestId('leave-hub-btn').click();
  await expect(guestRoom.getByRole('button', { name: /re-join hub/i })).toHaveCount(0);
  const friendCard = guestRoom.getByTestId('friend-hub-card').first();
  await expect(friendCard).toBeVisible();
  await expect(friendCard.getByRole('button', { name: /watch/i })).toBeVisible({ timeout: 10_000 });
  await friendCard.getByRole('button', { name: /watch/i }).click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeVisible();
  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await expect(guestRoom.getByTestId('connection-failure-alert')).toBeHidden();
  await waitForContinuousPlayback(guestRoom, 1, 1400);

  // Repeat leave -> direct Friend Hubs Watch re-entry while Host continues sharing
  await guestRoom.getByTestId('leave-hub-btn').click();
  await expect(friendCard).toBeVisible();
  await expect(friendCard.getByRole('button', { name: /watch/i })).toBeVisible({ timeout: 10_000 });
  await friendCard.getByRole('button', { name: /watch/i }).click();

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 1400);

  await ownerRoom.getByTestId('leave-hub-btn').click();
  await expect(ownerRoom.getByTestId('my-hub-code')).toBeVisible();
  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeVisible();

  await ownerRoom.getByTestId('open-my-hub-btn').click();
  await expect(ownerRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();

  await guestRoom.getByRole('button', { name: /knock again/i }).click();
  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 1000);

  // Simulate an ungraceful guest disconnect (no peer_left sent) and verify accepting
  // the returning knock cleans up the previous connection cleanly without duplicate peers.
  const ownerHubId = owner.hubCode;
  const guestHash = guestRoom.url().split('#')[1] ?? `/stream?hubId=${encodeURIComponent(ownerHubId)}&autoStart=false`;
  const contextCookies = await guestRoom.evaluate(() => sessionStorage.getItem('elfy_test_machine_uid') || '');

  await guestRoom.close({ runBeforeUnload: false });
  const guestRoomReborn = await initPeerPage(context, contextCookies);
  await guestRoomReborn.goto(`/#${guestHash}`);

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoomReborn.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoomReborn.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoomReborn, 1, 1400);

  // Both peers sharing should show exactly 1 remote tile per side by default (no duplicate stale peer)
  await guestRoomReborn.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(1);
  await expect(guestRoomReborn.getByTestId('stream-tile')).toHaveCount(1);
  await waitForContinuousPlayback(ownerRoom, 1, 1200);
});

test('Test 11 — Dock Right-Click Context Menu & Connection Failure Diagnostics', async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const context = await createTrackedContext(browser);
  const ownerUid = createRunUid('t11-owner');

  const ownerPage = await initPeerPage(context, ownerUid);
  await openHomeAndSetConsent(ownerPage, 'decline');
  const ownerHubCode = await readMyHubCode(ownerPage);

  // Left-click and Ctrl+Left-click on Companion dock/brand must NOT open context menu
  await ownerPage.getByTestId('dock-brand-trigger').click({ button: 'left' });
  await expect(ownerPage.getByTestId('dock-context-menu')).toBeHidden();
  await ownerPage.getByTestId('dock-brand-trigger').click({ modifiers: ['Control'] });
  await expect(ownerPage.getByTestId('dock-context-menu')).toBeHidden();

  // Right-click on Companion dock/brand opens context menu with Close Elfy
  await ownerPage.getByTestId('dock-brand-trigger').click({ button: 'right' });
  await expect(ownerPage.getByTestId('dock-context-menu')).toBeVisible();
  await expect(ownerPage.getByTestId('close-elfy-menu-btn')).toBeVisible();
  await ownerPage.getByTestId('dismiss-dock-menu-btn').click();
  await expect(ownerPage.getByTestId('dock-context-menu')).toBeHidden();

  const ownerRoom = await openOwnerRoom(ownerPage);

  // Left-click and Ctrl+Left-click on Watch Room BottomDock must NOT open context menu
  await ownerRoom.getByTestId('bottom-dock').click({ button: 'left' });
  await expect(ownerRoom.getByTestId('dock-context-menu')).toBeHidden();
  await ownerRoom.getByTestId('bottom-dock').click({ modifiers: ['Control'] });
  await expect(ownerRoom.getByTestId('dock-context-menu')).toBeHidden();

  // Right-click on Watch Room BottomDock opens Elfy context menu cleanly
  await ownerRoom.getByTestId('bottom-dock').click({ button: 'right' });
  await expect(ownerRoom.getByTestId('dock-context-menu')).toBeVisible();
  await expect(ownerRoom.getByTestId('close-elfy-menu-btn')).toBeVisible();
  await ownerRoom.getByTestId('dismiss-dock-menu-btn').click();
  await expect(ownerRoom.getByTestId('dock-context-menu')).toBeHidden();

  // Trigger a screen capture failure and verify stage + exact reason + Reconnect recovery
  await ownerRoom.evaluate(() => {
    const win = window as unknown as { __ELFY_FORCE_SYNTHETIC_STREAM__?: boolean };
    win.__ELFY_FORCE_SYNTHETIC_STREAM__ = false;
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getDisplayMedia: async () => {
          throw new Error('Screen permission denied by OS policy');
        },
      },
    });
  });

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('connection-failure-alert')).toBeVisible();
  await expect(ownerRoom.getByTestId('connection-failure-stage')).toHaveText('Screen Capture');
  await expect(ownerRoom.getByTestId('connection-failure-reason')).toContainText(
    'Screen permission denied by OS policy'
  );

  // Reconnect button clears failure alert and restores healthy hub state
  await ownerRoom.getByTestId('retry-connection-btn').click();
  await expect(ownerRoom.getByTestId('connection-failure-alert')).toBeHidden();
  await expect(ownerRoom.getByTestId('multi-stream-hub')).toBeVisible();

  // Verify SDP handshake failure diagnostic when a guest is accepted without receiving a host offer
  const guestUid = createRunUid('t11-guest');
  const guestPage = await initPeerPage(context, guestUid);
  await openHomeAndSetConsent(guestPage, 'decline');
  const guestHubCode = await readMyHubCode(guestPage);
  const guestPeerSafe = extractPeerTag(guestHubCode).replace(/^#/, '');
  const phantomHub = 'elfy/hub/PhantomHost_9999';
  const phantomRoom = await knockGuestIntoHub(guestPage, phantomHub);

  await expect(phantomRoom.locator('[data-signaling-connected="true"]')).toBeVisible();
  await phantomRoom.waitForTimeout(250);

  await ownerRoom.evaluate(
    async ({ hubId, peerSafe }) => {
      const channel = new BroadcastChannel('elfy_test_signaling_bus');
      const envelope = {
        version: 1,
        messageId: `msg_accept_${Date.now()}`,
        hubId,
        senderPeerIdSafe: 'PhantomHost_9999',
        sentAt: Date.now(),
        payload: {
          type: 'knock_decision',
          accepted: true,
          sessionToken: `sess_phantom_${Date.now()}`,
          hostPeerIdSafe: 'PhantomHost_9999',
          hostDisplayName: 'PhantomHost',
          peerRoster: [
            {
              peerIdSafe: 'PhantomHost_9999',
              peerTag: 'PhantomHost#9999',
              displayName: 'PhantomHost',
              avatarUrl: '',
              role: 'owner',
              isStreaming: true,
              joinedAt: Date.now(),
            },
          ],
        },
      };
      channel.postMessage({ topic: `${hubId}/peer/${peerSafe}`, envelope });
      channel.postMessage({ topic: `${hubId}/peer/${peerSafe}/knock`, envelope });
      await new Promise<void>((resolve) => window.setTimeout(resolve, 250));
      channel.close();
    },
    { hubId: phantomHub, peerSafe: guestPeerSafe }
  );

  await expect(phantomRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await expect(phantomRoom.getByTestId('connection-failure-alert')).toBeVisible({ timeout: 12_000 });
  await expect(phantomRoom.getByTestId('connection-failure-stage')).toHaveText(
    'Offer / Answer Handshake'
  );
  await expect(phantomRoom.getByTestId('connection-failure-reason')).toContainText(
    'did not receive the WebRTC stream offer from host'
  );
  await expect(phantomRoom.getByTestId('connection-failure-details')).toContainText(
    'host=PhantomHost_9999'
  );

  // Verify knock toast notification records Allow/Decline actions and dispatching accept admits guest
  const toastGuestUid = createRunUid('t11-toast-guest');
  const toastGuestPage = await initPeerPage(context, toastGuestUid);
  await openHomeAndSetConsent(toastGuestPage, 'decline');
  const toastGuestHubCode = await readMyHubCode(toastGuestPage);
  const toastGuestPeerSafe = extractPeerTag(toastGuestHubCode).replace(/^#/, '');
  const secondGuestRoom = await knockGuestIntoHub(toastGuestPage, ownerHubCode);

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  const recordedToast = await ownerRoom.evaluate(() => {
    const win = window as unknown as {
      __ELFY_LAST_KNOCK_NOTIFICATION__?: {
        actions?: string[];
        peerIdSafe?: string;
        hubId?: string;
        replyTopic?: string;
      };
    };
    return win.__ELFY_LAST_KNOCK_NOTIFICATION__ ?? null;
  });
  expect(recordedToast).not.toBeNull();
  expect(recordedToast?.actions).toEqual(['Allow', 'Decline']);
  expect(recordedToast?.peerIdSafe).toBe(toastGuestPeerSafe);

  await ownerRoom.evaluate((payload) => {
    window.dispatchEvent(
      new CustomEvent('elfy-knock-toast-action', {
        detail: {
          action: 'accept',
          peerIdSafe: payload?.peerIdSafe ?? '',
          displayName: 'Guest',
          peerTag: '',
          hubId: payload?.hubId ?? '',
          replyTopic: payload?.replyTopic ?? '',
        },
      })
    );
  }, recordedToast);

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeHidden();
  await expect(secondGuestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(secondGuestRoom.getByTestId('multi-stream-hub')).toBeVisible();
});

test('Test 12 — Automatic Hardware-First Codec Selection Without User Picker', async ({
  browser,
}) => {
  const context = await createTrackedContext(browser);
  const ownerUid = createRunUid('t12-owner');
  const guestUid = createRunUid('t12-guest');

  const ownerPage = await initPeerPage(context, ownerUid);
  await ownerPage.addInitScript(() => {
    const win = window as unknown as { __ELFY_CODEC_PREFS_APPLIED__?: string[][] };
    win.__ELFY_CODEC_PREFS_APPLIED__ = [];

    if (navigator.mediaCapabilities) {
      navigator.mediaCapabilities.encodingInfo = async (config) => {
        const contentType = config.type === 'webrtc' ? config.video?.contentType ?? '' : '';
        const isH264 = contentType.toLowerCase().includes('h264');
        return {
          supported: true,
          smooth: true,
          powerEfficient: isH264,
        };
      };
    }

    const proto = RTCRtpTransceiver?.prototype;
    if (proto && typeof proto.setCodecPreferences === 'function') {
      const orig = proto.setCodecPreferences;
      proto.setCodecPreferences = function (codecs: RTCRtpCodec[]) {
        win.__ELFY_CODEC_PREFS_APPLIED__?.push(codecs.map((c) => c.mimeType));
        return orig.call(this, codecs);
      };
    }
  });

  await openHomeAndSetConsent(ownerPage, 'decline');
  const ownerHubCode = await readMyHubCode(ownerPage);

  const guestPage = await initPeerPage(context, guestUid);
  await openHomeAndSetConsent(guestPage, 'decline');

  const ownerRoom = await openOwnerRoom(ownerPage);
  const guestRoom = await knockGuestIntoHub(guestPage, ownerHubCode);
  await ownerRoom.getByTestId('accept-knock-btn').click();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 800);

  // Confirm no manual codec picker is exposed to the user in the dock or settings popover
  await expect(ownerRoom.getByTestId('bottom-dock').locator('select')).toHaveCount(0);
  await ownerRoom.getByTestId('stream-settings-btn').click();
  await expect(ownerRoom.getByTestId('stream-settings-popover')).toBeVisible();
  await expect(ownerRoom.getByTestId('bottom-dock').locator('select')).toHaveCount(0);
  await ownerRoom.keyboard.press('Escape');
  await expect(ownerRoom.getByTestId('stream-settings-popover')).toBeHidden();

  // Confirm hardware-efficient H.264 was ranked at index 0 when setCodecPreferences ran
  const appliedLists = await ownerRoom.evaluate(() => {
    const win = window as unknown as { __ELFY_CODEC_PREFS_APPLIED__?: string[][] };
    return win.__ELFY_CODEC_PREFS_APPLIED__ ?? [];
  });
  if (appliedLists.length > 0) {
    const latest = appliedLists[appliedLists.length - 1];
    const hasH264 = latest.some((mime) => mime.toLowerCase() === 'video/h264');
    if (hasH264) {
      expect(latest[0]?.toLowerCase()).toBe('video/h264');
    }
  }
});

const joinAdditionalGuestToOwnerHub = async (
  context: BrowserContext,
  ownerRoom: Page,
  ownerHubCode: string,
  prefix: string
): Promise<{ guest: PeerSession; guestRoom: Page }> => {
  const guestUid = createRunUid(prefix);
  const guestPage = await initPeerPage(context, guestUid);
  await openHomeAndSetConsent(guestPage, 'decline');
  const guestHubCode = await readMyHubCode(guestPage);
  const guestRoom = await knockGuestIntoHub(guestPage, ownerHubCode);

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();

  return {
    guest: { page: guestPage, uid: guestUid, hubCode: guestHubCode },
    guestRoom,
  };
};

const readTileVideoAudioState = async (
  page: Page,
  peerIdSafe: string
): Promise<{ found: boolean; volume: number; muted: boolean }> => {
  return page.evaluate((targetPeerId: string) => {
    const tile = document.querySelector(
      `[data-testid="stream-tile"][data-peer-id="${targetPeerId}"]`
    );
    const video = tile?.querySelector('video') as HTMLVideoElement | null;
    if (!video) {
      return { found: false, volume: -1, muted: false };
    }
    return {
      found: true,
      volume: Number(video.volume.toFixed(2)),
      muted: video.muted,
    };
  }, peerIdSafe);
};

const assertSvgChartRendered = async (
  container: ReturnType<Page['getByTestId']>
): Promise<void> => {
  await expect(container).toBeVisible();
  const svg = container.locator('svg.recharts-surface').first();
  await expect(svg).toBeVisible();
  await expect
    .poll(async () => {
      const box = await svg.boundingBox();
      const pathCount = await svg.locator('path').count();
      return Boolean(box && box.width > 10 && box.height > 10 && pathCount > 0);
    })
    .toBe(true);
};

test('Test 13 — Hub Side Panel Participants, Local Per-Peer Volume Control & Host Kick', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await createTrackedContext(browser);
  const { owner, guest: guest1, ownerRoom, guestRoom: guest1Room } = await admitGuestToOwnerHub(
    context,
    't13'
  );
  const { guest: guest2, guestRoom: guest2Room } = await joinAdditionalGuestToOwnerHub(
    context,
    ownerRoom,
    owner.hubCode,
    't13-guest2'
  );

  const ownerPeerSafe = extractPeerTag(owner.hubCode).replace(/^#/, '');
  const guest1PeerSafe = extractPeerTag(guest1.hubCode).replace(/^#/, '');
  const guest2PeerSafe = extractPeerTag(guest2.hubCode).replace(/^#/, '');

  // Owner and Guest 1 both broadcast so host sees Guest 1's stream and both guests watch Owner.
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();
  await waitForContinuousPlayback(guest1Room, 1, 500);
  await waitForContinuousPlayback(guest2Room, 1, 500);

  await guest1Room.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(ownerRoom, 1, 500);
  await waitForContinuousPlayback(guest2Room, 2, 500);

  // Host opens Hub Side Panel -> Participants list and verifies single close button, cards, sparklines, and telemetry buttons.
  await ownerRoom.getByTestId('toggle-participants-panel-btn').click();
  const hubSidePanel = ownerRoom.getByTestId('hub-side-panel');
  await expect(hubSidePanel).toBeVisible();
  await expect(ownerRoom.getByTestId('close-hub-panel-btn')).toHaveCount(1);
  await expect(hubSidePanel.getByRole('button', { name: /hide/i })).toHaveCount(0);
  const participantsPanel = ownerRoom.getByTestId('participants-panel');
  await expect(participantsPanel).toBeVisible();
  await expect(ownerRoom.getByTestId('hub-tab-participants')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('hub-tab-telemetry')).toHaveCount(0);
  await expect(ownerRoom.getByTestId('invite-copy-btn')).toHaveCount(0);
  await expect(participantsPanel).not.toContainText(/invite to room/i);

  const ownerCards = ownerRoom.getByTestId('participant-card');
  await expect(ownerCards).toHaveCount(3);

  const selfCardOnOwner = ownerRoom.locator(
    `[data-testid="participant-card"][data-peer-id="${ownerPeerSafe}"]`
  );
  await expect(selfCardOnOwner).toContainText('HOST');
  await expect(selfCardOnOwner).toContainText('YOU');
  await expect(selfCardOnOwner).toContainText('Local · No Echo');
  await expect(selfCardOnOwner.getByTestId('participant-volume-slider')).toHaveCount(0);
  await expect(selfCardOnOwner.getByTestId('kick-peer-btn')).toHaveCount(0);
  await expect(selfCardOnOwner.getByTestId('peer-telemetry-btn')).toBeVisible();
  await expect(selfCardOnOwner.getByTestId('peer-telemetry-btn')).toBeEnabled();
  await assertSvgChartRendered(selfCardOnOwner);

  const guest1CardOnOwner = ownerRoom.locator(
    `[data-testid="participant-card"][data-peer-id="${guest1PeerSafe}"]`
  );
  await expect(guest1CardOnOwner).toContainText('GUEST');
  await expect(guest1CardOnOwner).toContainText('LIVE');
  await expect(guest1CardOnOwner.getByTestId('kick-peer-btn')).toBeVisible();
  await expect(guest1CardOnOwner.getByTestId('peer-telemetry-btn')).toBeVisible();
  await expect(guest1CardOnOwner.getByTestId('peer-telemetry-btn')).toBeEnabled();
  await assertSvgChartRendered(guest1CardOnOwner);

  const nonStreamingCardOnOwner = ownerRoom.locator(
    `[data-testid="participant-card"]:not([data-peer-id="${ownerPeerSafe}"]):not([data-peer-id="${guest1PeerSafe}"])`
  );
  await expect(nonStreamingCardOnOwner).toHaveCount(1);
  await expect(nonStreamingCardOnOwner.getByTestId('peer-telemetry-btn')).toBeVisible();
  await expect(nonStreamingCardOnOwner.getByTestId('peer-telemetry-btn')).toBeDisabled();

  // Inspect Guest 1's inbound telemetry via the user list card action, then return to participants.
  await guest1CardOnOwner.getByTestId('peer-telemetry-btn').click();
  await expect(ownerRoom.getByTestId('telemetry-panel')).toBeVisible();
  await expect(ownerRoom.getByTestId('telemetry-user-header')).toContainText(/INBOUND/i);
  await ownerRoom.getByTestId('telemetry-back-btn').click();
  await expect(participantsPanel).toBeVisible();

  // Guest 1 opens Participants panel and adjusts ONLY local volume/mute for Owner's stream.
  await guest1Room.getByTestId('toggle-participants-panel-btn').click();
  await expect(guest1Room.getByTestId('participants-panel')).toBeVisible();
  await expect(guest1Room.getByTestId('kick-peer-btn')).toHaveCount(0);

  await expect
    .poll(() => readTileVideoAudioState(guest1Room, ownerPeerSafe))
    .toEqual({ found: true, volume: 1, muted: false });
  await expect
    .poll(() => readTileVideoAudioState(guest2Room, ownerPeerSafe))
    .toEqual({ found: true, volume: 1, muted: false });

  const ownerCardOnGuest1 = guest1Room.locator(
    `[data-testid="participant-card"][data-peer-id="${ownerPeerSafe}"]`
  );
  const volumeSlider = ownerCardOnGuest1.getByTestId('participant-volume-slider');
  const muteBtn = ownerCardOnGuest1.getByTestId('participant-mute-btn');

  await volumeSlider.fill('35');
  await expect(ownerCardOnGuest1).toContainText('35%');
  await expect
    .poll(() => readTileVideoAudioState(guest1Room, ownerPeerSafe))
    .toEqual({ found: true, volume: 0.35, muted: false });

  // Guest 2 and Host must remain completely unaffected by Guest 1's local volume adjustment.
  expect(await readTileVideoAudioState(guest2Room, ownerPeerSafe)).toEqual({
    found: true,
    volume: 1,
    muted: false,
  });
  expect(await readTileVideoAudioState(ownerRoom, guest1PeerSafe)).toEqual({
    found: true,
    volume: 1,
    muted: false,
  });

  await muteBtn.click();
  await expect(ownerCardOnGuest1).toContainText('0%');
  await expect
    .poll(() => readTileVideoAudioState(guest1Room, ownerPeerSafe))
    .toEqual({ found: true, volume: 0, muted: true });
  expect(await readTileVideoAudioState(guest2Room, ownerPeerSafe)).toEqual({
    found: true,
    volume: 1,
    muted: false,
  });

  await muteBtn.click();
  await expect(ownerCardOnGuest1).toContainText('35%');
  await expect
    .poll(() => readTileVideoAudioState(guest1Room, ownerPeerSafe))
    .toEqual({ found: true, volume: 0.35, muted: false });

  // Host kicks Guest 1: Guest 1 sees kicked banner and stops receiving video; Host & Guest 2 drop Guest 1.
  await guest1CardOnOwner.getByTestId('kick-peer-btn').click();

  await expect(guest1Room.getByTestId('kicked-from-room-banner')).toBeVisible();
  await expect(guest1Room.getByTestId('multi-stream-hub')).toBeHidden();
  await expect(guest1Room.locator('video')).toHaveCount(0);

  await expect(
    ownerRoom.locator(`[data-testid="participant-card"][data-peer-id="${guest1PeerSafe}"]`)
  ).toHaveCount(0);
  await expect(ownerCards).toHaveCount(2);
  await expect(
    ownerRoom.locator(`[data-testid="participant-card"][data-peer-id="${guest2PeerSafe}"]`)
  ).toBeVisible();
  await expect(
    ownerRoom.locator(`[data-testid="stream-tile"][data-peer-id="${guest1PeerSafe}"]`)
  ).toHaveCount(0);
  await expect(ownerRoom.getByTestId('local-stream-hidden-card')).toBeVisible();

  // Guest 2 remains connected to Owner's stream without interruption.
  await expect(
    guest2Room.locator(`[data-testid="stream-tile"][data-peer-id="${guest1PeerSafe}"]`)
  ).toHaveCount(0);
  await waitForContinuousPlayback(guest2Room, 1, 600);

  await guest1Room.getByTestId('kicked-back-home-btn').click();
  await expect(guest1Room.getByTestId('my-hub-code')).toBeVisible();
});

test('Test 14 — Telemetry Charts, Time Windows, Layout Modes & Responsive Side Panel', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const context = await createTrackedContext(browser);
  const { ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't14');

  // Enable two active stage tiles (Owner self-preview + Guest share) for Grid/Spotlight/Focus verification.
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await ownerRoom.getByTestId('toggle-self-preview-btn').click();
  await guestRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(ownerRoom, 2, 600);
  await waitForContinuousPlayback(guestRoom, 1, 600);

  // Verify top bar has no standalone telemetry icon; open streaming peer telemetry via Participants list.
  await expect(ownerRoom.getByTestId('toggle-telemetry-panel-btn')).toHaveCount(0);
  await ownerRoom.getByTestId('toggle-participants-panel-btn').click();
  await expect(ownerRoom.getByTestId('hub-side-panel')).toBeVisible();
  await expect(ownerRoom.getByTestId('participants-panel')).toBeVisible();
  await expect(ownerRoom.getByTestId('peer-telemetry-btn')).toHaveCount(2);

  await ownerRoom.getByTestId('peer-telemetry-btn').first().click();
  await expect(ownerRoom.getByTestId('telemetry-panel')).toBeVisible();
  await expect(ownerRoom.getByTestId('telemetry-user-header')).toContainText(/OUTBOUND/i);

  const bitrateChart = ownerRoom.getByTestId('telemetry-bitrate-chart');
  const fpsChart = ownerRoom.getByTestId('telemetry-fps-chart');
  const rttChart = ownerRoom.getByTestId('telemetry-rtt-chart');

  await assertSvgChartRendered(bitrateChart);
  await assertSvgChartRendered(fpsChart);
  await assertSvgChartRendered(rttChart);

  const btn1m = ownerRoom.getByTestId('telemetry-window-1m');
  const btn5m = ownerRoom.getByTestId('telemetry-window-5m');
  const btn15m = ownerRoom.getByTestId('telemetry-window-15m');

  await expect(btn1m).toHaveAttribute('aria-selected', 'true');
  await expect(bitrateChart).toContainText('-60s');

  await btn5m.click();
  await expect(btn5m).toHaveAttribute('aria-selected', 'true');
  await expect(btn1m).toHaveAttribute('aria-selected', 'false');
  await expect(bitrateChart).toContainText('-5m');

  await btn15m.click();
  await expect(btn15m).toHaveAttribute('aria-selected', 'true');
  await expect(btn5m).toHaveAttribute('aria-selected', 'false');
  await expect(bitrateChart).toContainText('-15m');

  await btn1m.click();
  await expect(btn1m).toHaveAttribute('aria-selected', 'true');
  await expect(bitrateChart).toContainText('-60s');

  // Switch to the other streaming user via quick switcher, return to Participants, and close cleanly.
  const switcherButtons = ownerRoom.locator('[data-testid^="telemetry-switch-"]');
  await expect(switcherButtons).toHaveCount(2);
  await switcherButtons.nth(1).click();
  await expect(ownerRoom.getByTestId('telemetry-user-header')).toContainText(/INBOUND/i);

  await ownerRoom.getByTestId('telemetry-back-btn').click();
  await expect(ownerRoom.getByTestId('participants-panel')).toBeVisible();
  await ownerRoom.getByTestId('close-hub-panel-btn').click();
  await expect(ownerRoom.getByTestId('hub-side-panel')).toBeHidden();

  // Verify Grid, Spotlight, and Focus layout modes via Header segmented switcher.
  await expect(ownerRoom.getByTestId('layout-mode-grid')).toHaveAttribute('aria-pressed', 'true');
  await expect(ownerRoom.getByTestId('streams-grid')).toBeVisible();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(2);

  await ownerRoom.getByTestId('layout-mode-spotlight').click();
  await expect(ownerRoom.getByTestId('layout-mode-spotlight')).toHaveAttribute(
    'aria-pressed',
    'true'
  );
  await expect(ownerRoom.getByTestId('streams-spotlight')).toBeVisible();

  await ownerRoom.getByTestId('layout-mode-focus').click();
  await expect(ownerRoom.getByTestId('layout-mode-focus')).toHaveAttribute('aria-pressed', 'true');
  await expect(ownerRoom.getByTestId('streams-focus')).toBeVisible();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(1);

  await ownerRoom.getByTestId('layout-mode-grid').click();
  await expect(ownerRoom.getByTestId('streams-grid')).toBeVisible();

  // Verify zero horizontal overflow across 1440x900, 768x1024, and 360x580 with side panel open/closed.
  const viewports = [
    { width: 1440, height: 900 },
    { width: 768, height: 1024 },
    { width: 360, height: 580 },
  ];

  for (const vp of viewports) {
    await ownerRoom.setViewportSize(vp);
    await expect(ownerRoom.getByTestId('multi-stream-hub')).toBeVisible();
    await expect(ownerRoom.getByTestId('bottom-dock')).toBeVisible();
    await assertNoHorizontalOverflow(ownerRoom);

    await ownerRoom.getByTestId('stream-settings-btn').click();
    const popover = ownerRoom.getByTestId('stream-settings-popover');
    await expect(popover).toBeVisible();
    const popoverBox = await popover.boundingBox();
    expect(popoverBox).not.toBeNull();
    if (popoverBox) {
      expect(popoverBox.x).toBeGreaterThanOrEqual(0);
      expect(popoverBox.x + popoverBox.width).toBeLessThanOrEqual(vp.width + 1);
    }
    await assertNoHorizontalOverflow(ownerRoom);
    await ownerRoom.keyboard.press('Escape');
    await expect(popover).toBeHidden();

    await ownerRoom.getByTestId('toggle-participants-panel-btn').click();
    await expect(ownerRoom.getByTestId('hub-side-panel')).toBeVisible();
    await expect(ownerRoom.getByTestId('participants-panel')).toBeVisible();
    await assertNoHorizontalOverflow(ownerRoom);

    await ownerRoom.getByTestId('peer-telemetry-btn').first().click();
    await expect(ownerRoom.getByTestId('telemetry-panel')).toBeVisible();
    await assertSvgChartRendered(bitrateChart);
    await assertNoHorizontalOverflow(ownerRoom);

    await ownerRoom.getByTestId('telemetry-back-btn').click();
    await expect(ownerRoom.getByTestId('participants-panel')).toBeVisible();
    await ownerRoom.getByTestId('close-hub-panel-btn').click();
    await expect(ownerRoom.getByTestId('hub-side-panel')).toBeHidden();
    await assertNoHorizontalOverflow(ownerRoom);
  }

  // Also verify Spotlight and Focus modes fit cleanly at narrow 360x580 viewport.
  await ownerRoom.getByTestId('layout-mode-spotlight').click();
  await expect(ownerRoom.getByTestId('streams-spotlight')).toBeVisible();
  await assertNoHorizontalOverflow(ownerRoom);

  await ownerRoom.getByTestId('layout-mode-focus').click();
  await expect(ownerRoom.getByTestId('streams-focus')).toBeVisible();
  await assertNoHorizontalOverflow(ownerRoom);
});

test('Test 15 — Real WebRTC Audio Telemetry & Video-Only Honesty', async ({ browser }) => {
  test.setTimeout(60_000);
  const context = await createTrackedContext(browser);
  const { ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't15');

  // Inject a real Canvas video + Web Audio Opus oscillator stream on the Owner before sharing.
  await ownerRoom.evaluate(() => {
    const win = window as unknown as {
      __ELFY_TEST_STREAM__?: MediaStream;
      __ELFY_CLEANUP_TEST_AUDIO__?: () => void;
    };

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');
    let frame = 0;
    const drawFrame = () => {
      if (!ctx) return;
      frame += 1;
      ctx.fillStyle = frame % 2 === 0 ? '#0b1020' : '#161b2e';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fe2864';
      ctx.fillRect((frame * 17) % 520, 90, 96, 96);
    };
    drawFrame();
    const timer = window.setInterval(drawFrame, 33);

    const stream = canvas.captureStream(30);
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioCtx = new AudioCtx();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    const dest = audioCtx.createMediaStreamDestination();
    osc.frequency.value = 440;
    gain.gain.value = 0.08;
    osc.connect(gain);
    gain.connect(dest);
    osc.start();

    const resumeAudio = () => {
      void audioCtx.resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resumeAudio, { once: true });
    window.addEventListener('click', resumeAudio, { once: true });
    resumeAudio();

    for (const audioTrack of dest.stream.getAudioTracks()) {
      stream.addTrack(audioTrack);
    }

    win.__ELFY_TEST_STREAM__ = stream;
    win.__ELFY_CLEANUP_TEST_AUDIO__ = () => {
      window.clearInterval(timer);
      window.removeEventListener('pointerdown', resumeAudio);
      window.removeEventListener('click', resumeAudio);
      try {
        osc.stop();
      } catch {
        // Ignore if oscillator was already stopped
      }
      void audioCtx.close().catch(() => {});
      delete win.__ELFY_TEST_STREAM__;
    };
  });

  // Start sharing video + real audio, and wait for Guest playback.
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 600);

  // Guest opens Owner's inbound telemetry via Participants list and verifies real Opus audio telemetry.
  await guestRoom.getByTestId('toggle-participants-panel-btn').click();
  await expect(guestRoom.getByTestId('participants-panel')).toBeVisible();
  await guestRoom.locator('[data-testid="peer-telemetry-btn"]:not([disabled])').first().click();

  const guestTelemetryPanel = guestRoom.getByTestId('telemetry-panel');
  await expect(guestTelemetryPanel).toBeVisible();
  await expect(guestTelemetryPanel.getByTestId('telemetry-user-header')).toContainText(/INBOUND/i);

  const audioCard = guestTelemetryPanel.getByTestId('telemetry-audio-card');
  await expect
    .poll(
      async () => {
        const text = await audioCard.innerText();
        return text;
      },
      { timeout: 20_000 }
    )
    .toMatch(/OPUS/i);

  await expect
    .poll(
      async () => {
        const text = await audioCard.innerText();
        return (
          /OPUS/i.test(text) &&
          /\d+(?:\.\d+)?\s*kHz/i.test(text) &&
          /\b[1-9]\d*(?:,\d+)*(?:\.\d+)?\s*kbps\b/i.test(text) &&
          /(?:SYNCHRONIZED|ACTIVE)/i.test(text) &&
          /Jitter Buffer/i.test(text)
        );
      },
      { timeout: 20_000 }
    )
    .toBe(true);

  // Stop sharing cleanly, remove injected A/V stream, and re-share a video-only canvas stream.
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await ownerRoom.evaluate(() => {
    const win = window as unknown as { __ELFY_CLEANUP_TEST_AUDIO__?: () => void };
    win.__ELFY_CLEANUP_TEST_AUDIO__?.();
    delete win.__ELFY_CLEANUP_TEST_AUDIO__;
  });

  // Confirm Guest auto-returns to Participants when inspected peer stops streaming.
  await expect(guestRoom.getByTestId('participants-panel')).toBeVisible({ timeout: 15_000 });

  // Owner starts a fresh video-only share and Guest inspects Owner's telemetry again.
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 600);
  await guestRoom.locator('[data-testid="peer-telemetry-btn"]:not([disabled])').first().click();
  await expect(guestTelemetryPanel).toBeVisible();
  await expect(audioCard).toContainText(/NO AUDIO/i);
  await expect(audioCard).toContainText(/Video Only Stream/i);
  await expect(audioCard).not.toContainText(/OPUS/i);
});
