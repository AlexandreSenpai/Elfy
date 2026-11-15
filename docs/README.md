# Elfy — Project & Architecture Documentation

Elfy is a multi-window desktop watch-party and low-latency screen-sharing application built with **Tauri v2**, **React 19**, **TypeScript 6**, **WebRTC**, **MQTT over WebSockets**, and **SQLite**. It runs both as a native desktop companion app (primarily targeting Windows tray/toast workflows alongside cross-platform Tauri support) and in pure browser/Playwright E2E test mode via automatic runtime adapter switching.

---

## Documentation Index

| Document | Scope | Key Visuals |
| --- | --- | --- |
| [01 — Architecture & Layers](./01-architecture-and-layers.md) | Hexagonal (Ports & Adapters) 6-layer frontend/backend structure, dependency rules, and Tauri vs. Browser dual-runtime matrix | [Architecture Layers SVG](./assets/architecture-layers.svg) + Mermaid Dependency Graph |
| [02 — Multi-Window & UI Flows](./02-multi-window-and-ui-flows.md) ([Multi-Window Diagram](./assets/multi-window-lifecycle.svg)) | Multi-window Tauri lifecycle (preloaded `main` & `stream`, lazy `register`), `HashRouter` routes, UI components, `data-testid` catalog, Elfy Rose theme & breakpoints | [Multi-Window Lifecycle SVG](./assets/multi-window-lifecycle.svg) + 9 Live App Screenshots |
| [03 — Signaling & WebRTC Engine](./03-signaling-and-webrtc-engine.md) | Canonical Hub IDs, MQTT topic topology, wire schemas, Discovery Probe, Knock-to-Enter Gate, modular `webrtc/` engine, automatic HW codec selection, opt-in self-preview, & reconnection timers | [Signaling & WebRTC Flow SVG](./assets/signaling-webrtc-flow.svg) + Mermaid Sequence & State Diagrams |
| [04 — Tauri Backend, Persistence & Telemetry](./04-tauri-backend-persistence-and-telemetry.md) | Rust modules (`lib.rs`, `db.rs`, `toast.rs`, `system_monitor.rs`), all 25 IPC commands, pooled SQLite `DbState`, WinRT Toast / `ToastState` pipeline, `sysinfo` metrics, GA4 consent-gated telemetry, CSP & permissions | SQLite ER Diagram + Toast Fallback Flow |
| [05 — Where-to-Change Modification Cookbook](./05-where-to-change-guide.md) | Task-oriented guide mapping common feature changes, protocol updates, native commands, and UI tweaks to exact files and symbols | Cross-layer Checklist & Scenario Index |
| [06 — Testing & Improvement Roadmap](./06-testing-and-improvement-roadmap.md) | Playwright E2E suite (Tests 1–12), Rust unit tests (11 tests), completed architectural refactors, dead code cleanup, and remaining prioritized improvements | Remediation & Tech-Debt Matrix |

---

## Visual Gallery Overview

### Architecture & Protocol Diagrams
- [Hexagonal 6-Layer Architecture (`architecture-layers.svg`)](./assets/architecture-layers.svg)
- [Multi-Window Lifecycle & Bus (`multi-window-lifecycle.svg`)](./assets/multi-window-lifecycle.svg)
- [Signaling & Full-Mesh WebRTC Flow (`signaling-webrtc-flow.svg`)](./assets/signaling-webrtc-flow.svg)

### Application Screenshots (`docs/assets/screenshots/`)
Captured live via Playwright against Vite (`127.0.0.1:1420`) with deterministic machine UIDs and synthetic WebRTC streams:
- [01 — Telemetry Consent Modal](./assets/screenshots/01-telemetry-consent.png)
- [02 — Companion Friend Hubs (Live Discovery)](./assets/screenshots/02-companion-hubs.png)
- [03 — Persona Registration / Edit Window](./assets/screenshots/03-register-persona.png)
- [04 — Guest Knock-to-Enter Waiting Gate](./assets/screenshots/04-guest-knock-gate.png)
- [05 — Host Knock Alert Toast Card](./assets/screenshots/05-host-knock-alert.png)
- [06 — Watch Room Multi-Stream Grid](./assets/screenshots/06-multi-stream-grid.png)
- [07 — Watch Room Spotlight Layout](./assets/screenshots/07-multi-stream-spotlight.png)
- [08 — Minimized Hub Banner inside Companion](./assets/screenshots/08-minimized-companion-banner.png)
- [09 — Connection / Screen Capture Failure Banner](./assets/screenshots/09-connection-failure-banner.png)

---

## Tech Stack at a Glance

| Layer | Technology / Crate / Package | Role |
| --- | --- | --- |
| Desktop Shell | Tauri `^2` (`tauri` + `tray-icon`, `tauri-plugin-positioner`, `tauri-plugin-opener`, `@skipperndt/plugin-machine-uid`) | Multi-window management, system tray, hardware UID, native IPC |
| Windows Notifications | `tauri-winrt-notification` `0.8` + PowerShell `NotifyIcon` fallback + `tauri-plugin-notification` | Interactive Allow/Decline Knock toasts & HKCU AUMID icon registration |
| Local Database | `rusqlite` (`bundled`) | WAL-mode SQLite (`elfy.sqlite`) for `user_profile` & `friend_hubs` |
| System Metrics | `sysinfo` | Throttled host CPU% and RAM usage monitoring |
| UI Framework | React `19.1`, `react-dom`, `react-router-dom` `^7.18.4` | Hash-routed views across 3 WebViews, CSS Modules + CSS custom properties |
| Real-Time Signaling | `mqtt` `^5.16.0` over `wss://broker.emqx.io:8084/mqtt` + `BroadcastChannel` | Hub discovery probes, knock admission requests, WebRTC SDP/ICE relay |
| Media & Mesh | Native Browser `RTCPeerConnection` + `RTCDataChannel` (`elfy-control`) | Full-mesh screen/audio streaming (up to 6 peers), `30`/`60`/`120` FPS & `720p`/`1080p`/Native presets, automatic HW-first codec selection (`H264`/`AV1`/`VP9`/`VP8`), opt-in local self-preview |
| Telemetry | Google Analytics 4 Measurement Protocol (`https://www.google-analytics.com/mp/collect`) | Strictly opt-in (`granted`), PII-stripped anonymous performance metrics |
| Build & Tests | `bun`, Vite `^8.0.16`, TypeScript `~6.0.3`, Playwright (`@playwright/test`), `cargo test` | Frontend bundling, Rust unit tests, headless WebRTC/mesh E2E suite |

---

## Quick Start & Commands

```bash
# Install dependencies
bun install

# Start Vite frontend dev server on http://localhost:1420 (browser/SPA mode)
bun run dev

# Build TypeScript + Vite production bundle (tsc && vite build)
bun run build

# Launch full Tauri v2 desktop app in dev mode (runs `bun run dev` automatically)
bun run tauri dev

# Build distributable Tauri desktop binary/installer
bun run tauri build

# Run Playwright End-to-End tests (12 scenarios in tests/elfy.spec.ts)
bun run test:e2e

# Run Rust backend unit tests (db, system_monitor, single-instance lock)
cargo test --manifest-path src-tauri/Cargo.toml
```

---

## Repository Structure Map

```text
elfy/
├── index.html                        # Root HTML shell, Google Fonts & Material Symbols links
├── package.json                      # Bun scripts & frontend/Playwright/Tauri JS deps
├── vite.config.ts                    # Port 1420 strictPort dev server (HMR 1421), ignores src-tauri
├── playwright.config.ts              # 1-worker headless Chromium config with fake WebRTC media flags
├── tsconfig.json / tsconfig.node.json# Strict TS configuration
├── public/                           # Avatars, Elfy mascot PNGs, SVG icons
├── src/
│   ├── main.tsx                      # React 19 entry point
│   ├── App.tsx                       # HashRouter (/, /stream, /register) + global TelemetryConsentModal
│   ├── domain/                       # Pure config constants, DTO contracts, runtime validators
│   ├── ports/                        # Hexagonal interfaces (IStorageRepository .. ILocalWindowBus)
│   ├── adapters/                     # Concrete Tauri + Browser/Playwright dual-runtime adapters
│   ├── hooks/                        # useProfile, useFriendHubsDiscovery, useRoomSession
│   ├── pages/                        # FriendHubsPage, StreamViewerPage, RegisterPage
│   ├── components/                   # 12 focused presentation components + CSS Modules
│   ├── styles/theme.css              # Elfy Rose color tokens, typography, custom scrollbars
│   ├── utils/                        # hubTopics, stun, notifications, tauri IPC wrappers
│   └── data/mockData.ts              # Avatar catalog, mascot icons, cute aliases, defaults
├── src-tauri/
│   ├── Cargo.toml                    # Rust crate dependencies & LTO release profile
│   ├── tauri.conf.json               # Preloaded windows (main/stream) + lazy register, bundle & strict CSP
│   ├── capabilities/default.json     # Tauri v2 ACL permissions for all windows
│   └── src/
│       ├── main.rs                   # Binary entrypoint calling elfy_lib::run()
│       ├── lib.rs                    # Single-instance lock, tray, blur/close handlers, lazy register window, 13 commands
│       ├── toast.rs                  # ToastState atomic routing/dedup + WinRT/PowerShell notifications, 5 commands
│       ├── db.rs                     # Pooled DbState SQLite connection, SHA-256 peer_tag derivation, 6 db_* commands
│       └── system_monitor.rs         # sysinfo global state & get_system_metrics command
├── tests/
│   └── elfy.spec.ts                  # 12 full-stack Playwright E2E multi-peer tests
└── docs/                             # This documentation suite, SVGs, and live screenshots
```
