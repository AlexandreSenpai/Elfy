# 06 — Testing Guide & Improvement Roadmap

This document covers Elfy's automated test suites, verified code discrepancies found during codebase analysis, unused/leftover artifacts ready for cleanup, and a prioritized architectural & UX improvement backlog.

---

## 1. Automated Test Suites

### A. Rust Backend Unit Tests (`cargo test`)
Located inline inside `src-tauri/src/db.rs`, `src-tauri/src/toast.rs`, `src-tauri/src/system_monitor.rs`, and `src-tauri/src/lib.rs`:

```bash
cargo test --manifest-path src-tauri/Cargo.toml
```

| Test Coverage | Module | Verifies |
| --- | --- | --- |
| `db::tests::*` (4 tests) | `src-tauri/src/db.rs` | Deterministic SHA-256 `peer_tag` derivation, profile init/update/120 FPS validation/telemetry consent round-trip, `friend_hubs` upsert/list/removal, pooled `DbState` connection reuse |
| `toast::tests::*` (4 tests) | `src-tauri/src/toast.rs` | `ToastState` message-ID & peer-cooldown notification deduplication, active owner room routing + single-consumer claim, inactive owner queueing + atomic consume |
| `system_monitor::tests::*` (2 tests) | `src-tauri/src/system_monitor.rs` | Metrics shape (`ramUsageMb <= ramTotalMb`) and high-load threshold triggers |
| `single_instance_lock_prevents_concurrent_holders` (1 test) | `src-tauri/src/lib.rs` | Exclusive OS file lock prevents a second Elfy instance from acquiring `elfy_single_instance.lock` |

### B. Playwright E2E Suite (`tests/elfy.spec.ts` — 12 Tests)
Configured in `playwright.config.ts` with `workers: 1`, `fullyParallel: false`, `timeout: 45_000`, `expect.timeout: 12_000`, fake WebRTC devices (`--use-fake-ui-for-media-stream`, `--use-fake-device-for-media-stream`, `--autoplay-policy=no-user-gesture-required`), and auto-launched Vite dev server (`bun run dev` on `http://localhost:1420`).

| Test Title (`tests/elfy.spec.ts`) |
| --- |
| `Test 1 — Telemetry Consent Alert & Opt-Out/Opt-In Gating` |
| `Test 2 — Machine Fingerprint Lock & Single Hub per User` |
| `Test 3 — Knock-to-Enter Gate & Automatic Friend Hub Saving` |
| `Test 4 — Bidirectional Streaming Stability & Grid/Spotlight/Fullscreen` |
| `Test 5 — 30/60/120 FPS, Resolution Presets, Self-Preview Toggle & Metrics Badge` |
| `Test 6 — Minimize Active Hub Without Exiting` |
| `Test 7 — Friend Hubs Live Discovery Probing` |
| `Test 8 — Responsive Viewport Layout` |
| `Test 9 — Host Pre-Shares Before Guest Knocks & Re-Share Recovery` |
| `Test 10 — Room Exit and Re-Entry / Re-Connection Stability` |
| `Test 11 — Dock Right-Click Context Menu & Connection Failure Diagnostics` |
| `Test 12 — Automatic Hardware-First Codec Selection Without User Picker` |

---

## 2. Verified Bugs, Completed Fixes & Tech Debt

### Completed Fixes (Previously Reported Issues Now Resolved)
- **Pooled SQLite `DbState` (`src-tauri/src/db.rs`)**: Replaced per-command connection opening/`ensure_schema()` with a single startup-initialized `Mutex<Connection>` in `tauri::State`.
- **Atomic `ToastState` & Double-Toast Fix (`src-tauri/src/toast.rs`, `useKnockGate.ts`, `useFriendHubsDiscovery.ts`)**: Replaced `localStorage` toast keys (`elfy_pending_toast_action` / `elfy_handled_toast_peer`) and eliminated double Windows toasts via message-ID + peer-cooldown deduplication and single-consumer `claim_toast_action`.
- **Real Capture Resolution & FPS Support (`captureManager.ts`, `useMediaSharing.ts`)**: Replaced hardcoded `'1080p'` metadata with selectable `'720p'` / `'1080p'` / `'source'` capture presets and `30` / `60` / `120` FPS control.

### Remaining Open Behavioral Mismatches
1. **`SqliteStorageRepository` Overrides SQLite Favorite Ordering**:
   - **Where**: `src-tauri/src/db.rs` (`list_friend_hubs_inner`) vs. `src/adapters/storageRepository.ts` (`SqliteStorageRepository.listFriendHubs`).
   - **Detail**: Rust explicitly orders saved hubs by `is_favorite DESC, last_joined_at DESC, hub_id ASC`, but the TypeScript adapter runs `sortHubsByRecent()` right afterward—erasing favorite priority. Additionally, `FriendHubs.tsx` currently lacks a UI toggle to mark `isFavorite`.
2. **Generic `'Hub'` Display Name Until First Knock Decision**:
   - **Where**: `src/utils/hubTopics.ts` (`normalizeHubTopic`, `extractHostFromHub`) & `src/hooks/useRoomSession.ts`.
   - **Detail**: Because normalized hub IDs strip display names down to the hash (`elfy/hub/<id>`), manually adding a Friend Hub shows `'Hub'` in Companion until the guest completes an accepted room join and persists `ownerNickname`.

### Dead Code, Leftover Dependencies & Unused Assets
| Artifact / Dependency | Evidence | Suggested Cleanup |
| --- | --- | --- |
| `tauri-plugin-notification` | JS `@tauri-apps/plugin-notification` was removed from `package.json`, yet `tauri-plugin-notification` stays in `src-tauri/Cargo.toml`, `lib.rs` (non-Windows cfg), and `src-tauri/capabilities/default.json` | Remove completely or gate cleanly behind non-Windows desktop notification support |
| `src/App.module.css` | Contains only a comment (`/* Global app root styles are managed via theme.css and individual page modules */`) | Delete file |
| `ScreenMode` `'left-hub'` & `.leftHub*` CSS | Unused state mode / styling remnants in UI modules (`src/domain/dtos.ts`, `StreamViewerPage.module.css`) | Remove dead branch or wire an explicit Left Room confirmation view |
| `StreamItem.previewImage` | Defined on `StreamItem` in `src/domain/dtos.ts` without active production rendering | Remove from DTO if unneeded |
| `/vite.svg` favicon in `index.html` + `src/assets/react.svg` + `public/tauri.svg` | Default template icons still present alongside `public/elfy.ico` & mascot PNGs | Point `index.html` favicon to Elfy branding (`elfy.ico` / `elfy-dock.png`) and remove unused SVGs |
| `public/avatar_05_beach.png` & `public/elfy-square.png` | Present in `public/` but omitted from `src/data/mockData.ts` (`AVATAR_OPTIONS` currently exposes 5 avatars: `01`, `02`, `03`, `04`, `06`) | Expose `avatar_05_beach.png` as a 6th persona choice or prune unused PNGs |

---

## 3. Architectural Milestones & Remaining Improvement Roadmap

### Completed Engineering Refactors & Streaming Optimizations
- **Pooled SQLite `DbState` (`src-tauri/src/db.rs`)**: Single startup-initialized `Mutex<Connection>` managed in `tauri::State`.
- **Atomic `ToastState` & Single-Fire Notifications (`src-tauri/src/toast.rs`)**: Rust-managed deduplication and cross-window toast action queue/claim.
- **Modular Hook & WebRTC Engine Decomposition**: Split `useRoomSession.ts` (`597` lines) into `useMediaSharing.ts`, `useMeshPeers.ts`, `useKnockGate.ts`, `useRoomMetrics.ts`, and `roomHelpers.ts`; split `WebRtcStreamEngine` (`213`-line facade) into `captureManager.ts`, `codecSelector.ts`, `peerNegotiator.ts`, `sdpBitrate.ts`, `dataChannelRouter.ts`, `statsCollector.ts`, and `peerTypes.ts`.
- **Decoupled Keepalive & Metrics Timers**: Separated peer `ping`/`pong` cleanup (`KEEPALIVE_POLL_MS`) from hardware/stats sampling (`METRICS_POLL_MS`).
- **Lazy `register` Window Lifecycle**: Removed eager startup preload of `register`; instantiated only when needed and closed/destroyed after setup.
- **Gaming Performance & Hardware Acceleration**: Automatic hardware-first codec preference (`H264 -> AV1 -> VP9 -> VP8` via `codecSelector.ts`), native screenshare `contentHint = ''` + `m=video` SDP BWE bitrate hints (`sdpBitrate.ts`), disabled CPU audio DSP, `30`/`60`/`120` FPS + `720p`/`1080p`/`source` capture presets, multi-viewer bitrate scaling, soft CPU throttle (`0.72`), and opt-in local self-preview (disabled by default).

### High Priority — Remaining Security & Reliability
1. **Replace Open Public EMQX Broker with Private / Auth-Scoped Signaling**:
   - `wss://broker.emqx.io:8084/mqtt` is a shared unauthenticated public broker (`SIGNALING_CONFIG.MQTT_BROKER_URL`). Any external MQTT client knowing/guessing a 10-hex `peer_tag` can publish `hub_status_request`, `knock_request`, or spoofed SDP payloads onto `elfy/hub/<id>/*`. Move to a self-hosted MQTT/WebSocket server with per-session JWT auth, TLS, and cryptographic envelope verification.
2. **Replace Public OpenRelay TURN Credentials & Externalize Telemetry Secrets**:
   - Metered public OpenRelay credentials in `src/utils/stun.ts` and `GA_API_SECRET` in `src/domain/config.ts` are bundled into client JS. Fetch ephemeral short-lived TURN REST credentials and proxy analytics if confidentiality matters.

### Medium Priority — Remaining Architecture & UX
3. **Bundle Fonts & Material Icons Locally for Offline Reliability**:
   - `index.html` fetches `Plus Jakarta Sans`, `JetBrains Mono`, and `Material Symbols Outlined` from `fonts.googleapis.com`. If offline or firewalled, icon ligatures render as literal text strings. Self-host `.woff2` assets under `public/`.
4. **Preserve Favorite Sorting & Expose UI Toggle**:
   - `SqliteStorageRepository.listFriendHubs()` still calls `sortHubsByRecent()` after Rust returns rows sorted by `is_favorite DESC`, and `FriendHubs.tsx` does not yet expose an `isFavorite` toggle.

### Low Priority / Scale — Future Enhancements
5. **Hydrate Nickname During `hub_status_response`**:
   - Include `hostDisplayName` / `hostAvatar` in `HubStatusResponsePayload` so saved Friend Hubs populate friend identity right upon `Add` / `Probe` without waiting for an accepted knock.
6. **Selective Forwarding Unit (SFU) Escape Hatch Beyond 6 Peers**:
   - Full-mesh WebRTC scales as $O(N^2)$ outbound streams per sharer (`MAX_CONCURRENT_PEERS = 6`). Introducing an SFU adapter behind `IStreamEngine` allows scaling past 6 simultaneous streams without changing UI or hooks.
