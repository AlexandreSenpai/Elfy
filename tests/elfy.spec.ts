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
  await optedInRoom.getByTestId('fps-toggle-btn').click();

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

  await page.goto('/#/register');
  await expect(page.getByTestId('locked-peer-tag')).toContainText(initialTag);
  await page.getByRole('button', { name: /happy/i }).click();
  await page.locator('input[type="text"]').first().fill('NovaFox');
  await page.getByRole('button', { name: /save changes|get started/i }).click();

  await expect(page.getByTestId('my-hub-code')).toContainText(`NovaFox${initialTag}`);
  await expect(page.getByTestId('my-hub-code')).toHaveCount(1);

  await page.reload();
  await expect(page.getByTestId('my-hub-code')).toContainText(`NovaFox${initialTag}`);

  await page.goto('/#/register');
  await expect(page.getByTestId('locked-peer-tag')).toContainText(initialTag);
  await page.getByRole('button', { name: /sleepy/i }).click();
  await page.locator('input[type="text"]').first().fill('PixelMochi');
  await page.getByRole('button', { name: /save changes|get started/i }).click();

  await expect(page.getByTestId('my-hub-code')).toContainText(`PixelMochi${initialTag}`);
  await expect(page.getByTestId('my-hub-code')).toHaveCount(1);
});

test('Test 3 — Knock-to-Enter Gate & Automatic Friend Hub Saving', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { owner, guest, guestRoom } = await admitGuestToOwnerHub(context, 't3');
  const ownerTag = extractPeerTag(owner.hubCode);

  await waitForSavedFriendHub(guestRoom, ownerTag);
  await guestRoom.goto('/#/');
  await expect(guest.page.getByTestId('friend-hubs-list')).toBeVisible();
  await expect(guest.page.getByTestId('friend-hub-card').first()).toContainText(ownerTag);
});

test('Test 4 — Bidirectional Streaming Stability & Grid/Spotlight/Fullscreen', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't4');

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 1600);

  await guestRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('streams-grid')).toBeVisible();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(2);
  await waitForContinuousPlayback(ownerRoom, 2, 800);

  await ownerRoom.getByTestId('layout-toggle-btn').click();
  await expect(ownerRoom.getByTestId('streams-spotlight')).toBeVisible();

  await enterFullscreenViewer(ownerRoom);
  await expect(ownerRoom.getByTestId('fullscreen-stream-viewer')).toBeVisible();
  await ownerRoom.keyboard.press('Escape');
  await expect(ownerRoom.getByTestId('fullscreen-stream-viewer')).toBeHidden();
});

test('Test 5 — 60 FPS / 30 FPS Dynamic Control & System/GPU Monitor', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { ownerRoom } = await admitGuestToOwnerHub(context, 't5');

  await ownerRoom.getByTestId('toggle-share-btn').click();
  const fpsBtn = ownerRoom.getByTestId('fps-toggle-btn');
  await expect(fpsBtn).toContainText(/60\s*FPS/i);
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText(/60\s*fps/i);

  await fpsBtn.click();
  await expect(fpsBtn).toContainText(/30\s*FPS/i);
  await expect(ownerRoom.getByTestId('stream-tile').first()).toContainText(/30\s*fps/i);

  await expect.poll(() => readObservedTrackFps(ownerRoom)).toBe(30);

  const metricsBadge = ownerRoom.getByTestId('system-metrics-badge');
  await expect(metricsBadge).toBeVisible();
  await expect(metricsBadge).toContainText(/CPU\s+\d+%.*RAM\s+\d+MB.*\d+\s*FPS/i);
});

test('Test 6 — Minimize Active Hub Without Exiting', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { owner, ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't6');

  const ownerCompanionHome = await initPeerPage(context, owner.uid);
  await ownerCompanionHome.goto('/#/');
  await expect(ownerCompanionHome.getByTestId('my-hub-code')).toBeVisible();

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 600);

  await ownerRoom.getByTestId('minimize-hub-btn').click();
  await expect(ownerRoom.getByTestId('watch-room-minimized-bar')).toBeVisible();
  await expect(ownerCompanionHome.getByTestId('minimized-hub-banner')).toBeVisible();

  await waitForContinuousPlayback(guestRoom, 1, 800);

  await ownerRoom.getByTestId('restore-watch-room-btn').click();
  await expect(ownerRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await expect(ownerCompanionHome.getByTestId('minimized-hub-banner')).toBeHidden();
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
  await waitForContinuousPlayback(ownerRoom, 1, 400);

  const guestRoom = await knockGuestIntoHub(guestPage, ownerHubCode);
  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 1400);

  await guestRoom.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(2);
  await waitForContinuousPlayback(ownerRoom, 2, 600);

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(guestRoom.getByTestId('stream-tile')).toHaveCount(1);
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await expect(guestRoom.getByTestId('stream-tile')).toHaveCount(2);
  await waitForContinuousPlayback(guestRoom, 2, 600);
});

test('Test 10 — Room Exit and Re-Entry / Re-Connection Stability', async ({ browser }) => {
  const context = await createTrackedContext(browser);
  const { ownerRoom, guestRoom } = await admitGuestToOwnerHub(context, 't10');

  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(guestRoom, 1, 800);

  await guestRoom.getByTestId('leave-hub-btn').click();
  await expect(guestRoom.getByRole('button', { name: /re-join hub/i })).toBeVisible();
  await guestRoom.getByRole('button', { name: /re-join hub/i }).click();

  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 1400);

  await ownerRoom.getByTestId('leave-hub-btn').click();
  await expect(ownerRoom.getByRole('button', { name: /re-join hub/i })).toBeVisible();
  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeVisible();

  await ownerRoom.getByRole('button', { name: /re-join hub/i }).click();
  await expect(ownerRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await ownerRoom.getByTestId('toggle-share-btn').click();
  await waitForContinuousPlayback(ownerRoom, 1, 400);

  await guestRoom.getByRole('button', { name: /knock again/i }).click();
  await expect(ownerRoom.getByTestId('host-knock-alert')).toBeVisible();
  await ownerRoom.getByTestId('accept-knock-btn').click();

  await expect(guestRoom.getByTestId('guest-knock-gate')).toBeHidden();
  await expect(guestRoom.getByTestId('multi-stream-hub')).toBeVisible();
  await waitForContinuousPlayback(guestRoom, 1, 1000);

  // Simulate an ungraceful guest disconnect (no peer_left sent) and verify accepting
  // the returning knock cleans up the previous connection cleanly without duplicate peers.
  const ownerUrl = ownerRoom.url();
  const hubQuery = new URL(ownerUrl).hash.split('?')[1] ?? '';
  const ownerHubId = new URLSearchParams(hubQuery).get('hubId') ?? '';
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

  // Both peers sharing should result in exactly 2 stream tiles (no duplicate stale peer)
  await guestRoomReborn.getByTestId('toggle-share-btn').click();
  await expect(ownerRoom.getByTestId('stream-tile')).toHaveCount(2);
  await expect(guestRoomReborn.getByTestId('stream-tile')).toHaveCount(2);
  await waitForContinuousPlayback(ownerRoom, 2, 1200);
});

test('Test 11 — Dock Right-Click Context Menu & Connection Failure Diagnostics', async ({
  browser,
}) => {
  const context = await createTrackedContext(browser);
  const ownerUid = createRunUid('t11-owner');

  const ownerPage = await initPeerPage(context, ownerUid);
  await openHomeAndSetConsent(ownerPage, 'decline');

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
});
