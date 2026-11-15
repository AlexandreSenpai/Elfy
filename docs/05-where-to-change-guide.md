# 05 — Where-to-Change Modification Cookbook

Use this lookup guide to jump straight to the exact files, symbols, and cross-layer touchpoints when modifying or extending Elfy.

---

## Quick Scenario Matrix

| What You Want to Change | Primary Files to Edit | Related Tests / Checklists |
| --- | --- | --- |
| Change peer limit or default FPS/resolution | `src/domain/config.ts`, `src/domain/validators.ts`, `src-tauri/src/db.rs` | Verify `canAcceptMorePeers()`, `isStreamFps` (`30 \| 60 \| 120`), & SQLite `preferred_fps` |
| Add a new MQTT signaling or DataChannel message | `src/domain/dtos.ts`, `src/domain/validators.ts`, `src/hooks/useMeshPeers.ts`, `src/hooks/useKnockGate.ts`, `src/hooks/useRoomSession.ts` | Add strict parser case before handling in mesh/knock hooks |
| Change Hub ID format or topic structure | `src/utils/hubTopics.ts` | Check `toSafePeerTag`, `normalizeHubTopic`, `useFriendHubsDiscovery`, `useRoomSession` |
| Add/modify ICE (STUN/TURN) servers | `src/utils/stun.ts` | Verify `WebRtcStreamEngine` / `peerNegotiator.ts` & Playwright tests |
| Modify hardware codec ranking, screen capture, or FPS/resolution | `src/adapters/webrtc/codecSelector.ts`, `src/adapters/webrtc/captureManager.ts`, `src/hooks/useMediaSharing.ts` | Keep codec selection automatic (no user picker) & self-preview opt-in (`false` by default) |
| Tweak WebRTC reconnect, ICE restart, or keepalive timers | `src/adapters/webrtc/peerNegotiator.ts`, `src/adapters/webrtc/dataChannelRouter.ts`, `src/hooks/useMeshPeers.ts`, `src/hooks/room/roomHelpers.ts` | Keep `KEEPALIVE_POLL_MS` (2s) independent of `METRICS_POLL_MS` (2s) & `HOST_OFFER_TIMEOUT_MS` (8s) |
| Change avatar catalog, mascot icons, or cute aliases | `src/data/mockData.ts`, `public/` | Check `AVATAR_OPTIONS`, `DEFAULT_USER_PROFILE`, `CUTE_ALIASES` |
| Modify window size, titlebar, tray, blur hide, or close behavior | `src-tauri/tauri.conf.json`, `src-tauri/src/lib.rs`, `src/pages/StreamViewerPage/StreamViewerPage.tsx` | Keep `MAIN_DRAG_GUARD_UNTIL_MS`, `is_cursor_inside_window`, & lazy `register` cleanup synced |
| Add a SQLite column or new table | `src-tauri/src/db.rs`, `src/domain/dtos.ts`, `src/ports/index.ts`, `src/adapters/storageRepository.ts` | Update `DbState` schema + both `SqliteStorageRepository` AND `TestFallbackStorageRepository` |
| Add a new Tauri IPC command | `src-tauri/src/lib.rs` (or `db.rs`/`toast.rs`/`system_monitor.rs`), `src-tauri/capabilities/default.json`, `src/utils/tauri.ts` | Register in `tauri::generate_handler![...]` + add non-Tauri fallback |
| Modify Windows Toast / Knock chime behavior | `src-tauri/src/toast.rs`, `src/utils/notifications.ts`, `src/hooks/useFriendHubsDiscovery.ts`, `src/hooks/useKnockGate.ts` | Preserve `ToastState` atomic dedup (`message_id` / peer cooldown) & `claim_toast_action` guard |
| Add or tweak UI components / context menu | `src/components/<Component>/<Component>.tsx`, `src/components/MultiStreamHub/*`, `src/pages/*` | Keep stable `data-testid` hooks referenced in `tests/elfy.spec.ts` |
| Update theme colors, fonts, or global scrollbars | `src/styles/theme.css`, `index.html`, `src-tauri/tauri.conf.json` (CSP) | Update CSP if introducing new font/CDN/fetch origins |
| Add or update anonymous GA4 telemetry events | `src/domain/dtos.ts` (`TelemetryEventName`, `TelemetryEventParams`), `src/adapters/telemetryAdapter.ts` | Update `sanitizeTelemetryParams()` + keep `'granted'` gate |

---

## Detailed Cross-Layer Checklists

### A. Adding a Persistent Field to User Profile or Friend Hubs
Updating persistence touches **both desktop SQLite and browser test fallback**:
1. **Rust Schema & Commands (`src-tauri/src/db.rs`)**:
   - Update `CREATE TABLE` inside `ensure_schema()`, `ProfileRowDto` / `FriendHubRowDto` Serde structs, and read/write SQL statements (`get_or_init_profile_inner`, `update_profile_inner`, `upsert_friend_hub_inner`, etc.).
2. **Domain DTO (`src/domain/dtos.ts`)**:
   - Add the field to `UserProfile` / `ProfileRowDto` / `FriendHubRecordDto` / `FriendHubViewModel`.
3. **Ports (`src/ports/index.ts`)**:
   - Update `IStorageRepository` update/upsert method signatures if writable.
4. **Dual Adapters (`src/adapters/storageRepository.ts`)**:
   - Map the field in `SqliteStorageRepository` **AND** mirror identical behavior/defaults in `TestFallbackStorageRepository` so browser development and `tests/elfy.spec.ts` remain parity-complete.
5. **Cross-Window Sync (`src/hooks/useProfile.ts`)**:
   - Ensure `profile_updated` on `localWindowBus` refreshes open windows automatically.

### B. Adding a New `elfy-control` DataChannel Control Action
1. Define the typed payload variant inside `DataChannelPayload` union in `src/domain/dtos.ts`.
2. Add explicit runtime type-guard validation inside `parseDataChannelMessage()` in `src/domain/validators.ts` (never skip validation on raw JSON).
3. Emit the envelope via `broadcastDataChannelMessage(...)` or `streamEngine.sendDataChannelMessage(peerId, ...)` from `src/hooks/useRoomSession.ts` / `useMeshPeers.ts`.
4. Handle the incoming message inside the DataChannel dispatch table in `src/hooks/useMeshPeers.ts`.

### C. Modifying Tauri Windows or Exposing New Native Capabilities
1. **Window Config (`src-tauri/tauri.conf.json`)**:
   - Configure dimensions, `url` hash route, transparency, `resizable`, or `skipTaskbar` for preloaded windows (`main`, `stream`) or update lazy creation in `show_register_window` (`src-tauri/src/lib.rs`).
   - Remember `lib.rs` configures `main` blur auto-hide and `stream` close-to-hide hooks by label (while `register` is created lazily and closed/destroyed on completion)—update `configure_main_window` / `configure_stream_window` / `show_register_window` if renaming window labels.
2. **Rust Handler (`src-tauri/src/lib.rs`, `toast.rs`, `db.rs`, `system_monitor.rs`)**:
   - Annotate function with `#[tauri::command]`, add it to `tauri::generate_handler![...]` inside `run()`.
3. **ACL Permissions (`src-tauri/capabilities/default.json`)**:
   - Grant any new plugin/window permission scopes required by Tauri v2 capability checks.
4. **CSP Whitelist (`src-tauri/tauri.conf.json`)**:
   - Any new external HTTP, WebSocket, or font origin must be added to `app.security.csp` (`connect-src`, `style-src`, `font-src`, etc.).
5. **Frontend Bridge (`src/utils/tauri.ts`)**:
   - Wrap the `invoke(...)` behind `isTauri()` / `safeInvoke(...)` with a clean browser noop/fallback.

### D. Modifying Watch Room Layout or Responsive Breakpoints
- **Grid vs. Spotlight tile ordering & active spotlight tracking**: `src/components/MultiStreamHub/MultiStreamHub.tsx` + `MultiStreamHub.module.css`.
- **Single tile player, autoplay unlock, volume slider, badges**: `src/components/MultiStreamHub/StreamTile.tsx` + `StreamTile.module.css`.
- **Dock actions, telemetry pill, FPS toggle**: `src/components/MultiStreamHub/BottomDock.tsx` + `BottomDock.module.css`.
- **Right-click Dock context menu (`Close Elfy` / `Dismiss`)**: `src/components/DockContextMenu/DockContextMenu.tsx`.
- **Window chrome, dragging regions, OS minimize state detection**: `src/components/Header/Header.tsx` + `src/pages/StreamViewerPage/StreamViewerPage.tsx`.
- **Global palette variables**: `src/styles/theme.css`.

### E. Modifying Signaling Transport or Replacing the Public MQTT Broker
- Broker URL and channel constants are centralized in `src/domain/config.ts` (`SIGNALING_CONFIG`).
- Broker options, reconnect timers (`reconnectPeriod: 4000`, `connectTimeout: 6000`), deduplication buffer (`MAX_SEEN_IDS = 500`), and Playwright `BroadcastChannel` bridging live inside `src/adapters/mqttSignalingAdapter.ts`.
- Remember to whitelist any replacement `wss://...` host inside `src-tauri/tauri.conf.json` (`app.security.csp`).
