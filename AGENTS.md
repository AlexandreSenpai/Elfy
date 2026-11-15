# AGENTS.md — Elfy Engineering Guidelines

This repository hosts **Elfy**, a Tauri v2 + React 19 + TypeScript desktop and web peer-to-peer screen-sharing application built on WebRTC, MQTT (`mqtt` / `BroadcastChannel` fallback), and a Rust SQLite / Windows notification backend.

---

## 1. Architecture & Layer Boundaries

Elfy follows a strict **Ports & Adapters** architecture. Keep dependencies pointing inward and never bypass layer boundaries:

- **Domain (`src/domain/`)**: Pure DTOs, runtime validators (`validators.ts`), and immutable constants (`config.ts`). Zero React, DOM, MQTT, or Tauri imports.
- **Ports (`src/ports/index.ts`)**: Framework-agnostic TypeScript interfaces (`IStorageRepository`, `ISignalingTransport`, `IStreamEngine`, `ISystemMonitor`, `ITelemetryProvider`, `ILocalWindowBus`).
- **Adapters (`src/adapters/`)**: Concrete browser/Tauri implementations of ports. Complex engines must be split into cohesive submodules under an adapter folder (e.g., `src/adapters/webrtc/`) and exposed behind a small facade (`WebRtcStreamEngine`).
- **Hooks (`src/hooks/`)**: Composable UI/session orchestration hooks consuming ports/adapters and exposing clean view models to pages.
- **UI Components & Pages (`src/components/`, `src/pages/`)**: Declarative React components. Never import MQTT, raw `RTCPeerConnection`, SQLite IPC, or `window.__TAURI__*` directly in pages/components.
- **Rust Backend (`src-tauri/src/`)**: Modular domain modules (`db.rs`, `toast.rs`, `system_monitor.rs`) wired into `lib.rs` using managed `tauri::State`.

---

## 2. Modularity & Anti-God-Class Rules

- **Strict single responsibility**: Avoid god classes and monolithic hooks. If a file exceeds ~300–400 lines or mixes unrelated responsibilities (transport I/O, state machines, timers, and UI formatting), decompose it into focused modules before adding new features.
- **WebRTC decomposition (`src/adapters/webrtc/`)**:
  - `peerTypes.ts` — shared peer entry state and pure health/cleanup helpers.
  - `codecSelector.ts` — automatic `MediaCapabilities` (`powerEfficient`) + `RTCRtpSender.getCapabilities` hardware codec ranking (`H264 -> AV1 -> VP9 -> VP8`), applied internally via `transceiver.setCodecPreferences()` without a manual user codec picker.
  - `captureManager.ts` — local `MediaStream` / canvas test capture, `720p` / `1080p` / `source` resolution scaling, native Chromium screenshare `contentHint` (`''`), disabled CPU audio DSP, bitrate scaling, and `30` / `60` / `120` FPS + track attachment.
  - `sdpBitrate.ts` — pure `m=video` SDP bitrate hint decorator (`b=AS`, `x-google-start-bitrate`, `x-google-min-bitrate`, `x-google-max-bitrate`) preventing BWE startup starvation on hardware encoders.
  - `peerNegotiator.ts` — `RTCPeerConnection` setup, hardware-first codec preferences, remote SDP BWE bitrate hints, perfect-negotiation offer/answer/ICE collision handling, and ICE restarts.
  - `dataChannelRouter.ts` — `RTCDataChannel` dispatch, keepalive pings/eviction, and in-band renegotiation.
  - `statsCollector.ts` — async `getStats()` aggregation (codecs, `encoderImplementation`, `qualityLimitationReason`, and delta `outboundBitrateKbps`).
  - `../webrtcStreamEngine.ts` — thin facade implementing `IStreamEngine`.
- **Room session hook decomposition (`src/hooks/`)**:
  - `useMediaSharing.ts` — screen share capture, resolution presets (`720p`/`1080p`/`source`), `30`/`60`/`120` FPS, opt-in local self-preview (`isLocalPreviewEnabled` off by default so streamers do not decode their own video while gaming), volumes/deafen, layout/fullscreen, and minimize/restore.
  - `useMeshPeers.ts` — P2P peer roster, signaling/DataChannel message handlers, profile sync, and dedicated keepalive timer.
  - `useKnockGate.ts` — knock request/approval/timeout flow, owner room state registration, and Windows toast action consumption.
  - `useRoomMetrics.ts` — `METRICS_POLL_MS` CPU/RAM and WebRTC stats sampling only.
  - `useRoomSession.ts` — top-level room orchestrator composing the four hooks and managing the MQTT connection lifecycle.
- **No duplicated logic**: Extract shared helpers instead of cloning blocks across signaling vs. DataChannel paths, or across components. Keep functions short with shallow nesting and early returns.

---

## 3. State Management, Concurrency & Multi-Window Coordination

- **Pooled SQLite in `tauri::State`**: Never open a fresh `rusqlite::Connection` or run `ensure_schema()` per Tauri command. Use `DbState` (`Mutex<Connection>`) initialized once during app setup in `src-tauri/src/lib.rs`.
- **Atomic cross-window coordination in Rust**: Elfy preloads the primary WebView2 windows (`main` and `stream` in `src-tauri/tauri.conf.json`) and creates `register` lazily on demand via `show_register_window` (closing/destroying it via `close_register_window` when persona setup finishes to save idle RAM). Never use `localStorage` polling or `setTimeout` delays to coordinate toast clicks or exclusive actions between windows.
  - Use `ToastState` in `src-tauri/src/toast.rs` (`register_owner_room_session`, `unregister_owner_room_session`, `consume_pending_toast_actions`, `claim_toast_action`, and deduplication inside `show_knock_notification`).
  - Use typed `LocalWindowBusMessage` events (`src/adapters/localWindowBus.ts` + `src/domain/validators.ts`) for window UI synchronization.
- **Keep codec selection automatic & self-preview opt-in**: Never expose a manual codec picker in the UI (`codecSelector.ts` handles hardware-first negotiation automatically), and keep `isLocalPreviewEnabled` disabled by default when starting screen sharing.
- **Decouple independent timers**: Never couple peer liveness / keepalive `ping`/`pong` cleanup (`KEEPALIVE_POLL_MS`) with UI hardware metrics polling (`METRICS_POLL_MS`).
- **One notification per knock**: Knock deduplication must run atomically on the Rust backend (by message ID and `(hub_id, peer_id_safe)` cooldown) AND pass `envelope.messageId` through `playKnockSound` / `showKnockNotification`, while skipping alerts in `useFriendHubsDiscovery` whenever the owner's `stream` room is active.

---

## 4. Dual-Runtime Parity & Test Hooks

- Every feature touching Tauri IPC, storage, signaling, or media capture must degrade gracefully in standard browser mode (`!isTauri()`) so `vite dev` / Playwright E2E tests work without the Tauri shell:
  - Storage falls back cleanly in `src/adapters/storageRepository.ts`.
  - Signaling uses `BroadcastChannel('elfy_test_signaling_bus')` when running under WebDriver/test mode (`src/adapters/mqttSignalingAdapter.ts`).
  - Toast actions support both Tauri `'knock-toast-action'` events and browser `'elfy-knock-toast-action'` `CustomEvent`s.
  - Preserve existing `data-testid` attributes and test window globals (`__ELFY_*`) relied upon by `tests/elfy.spec.ts`.
- Keep all external/IPC/network payloads validated at ingress in `src/domain/validators.ts`. Never trust unvalidated JSON from MQTT, `RTCDataChannel`, `localStorage`, or cross-window events.

---

## 5. Verification Commands

Run these checks after modifying TypeScript, React, WebRTC, Rust, or E2E flows:

- **Rust backend unit tests**: `cargo test --manifest-path src-tauri/Cargo.toml`
- **Frontend typecheck & production bundle**: `bun run build`
- **Playwright E2E suite**: `bun run test:e2e`
