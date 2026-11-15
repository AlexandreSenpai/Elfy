use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager, State};

#[cfg(target_os = "windows")]
use std::sync::Once;

#[cfg(target_os = "windows")]
const ELFY_AUMID: &str = "com.alexandresenpai.elfy";

#[cfg(target_os = "windows")]
static AUMID_INIT: Once = Once::new();

const MESSAGE_DEDUP_TTL: Duration = Duration::from_secs(60);
const PEER_ALERT_DEDUP_TTL: Duration = Duration::from_secs(3);
const PENDING_ACTION_TTL: Duration = Duration::from_secs(20);
const CLAIMED_ACTION_TTL: Duration = Duration::from_secs(60);

/// Payload emitted to the frontend and queued in Rust state when a user interacts
/// with a native knock toast notification.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnockToastActionEvent {
    pub action_id: String,
    pub action: String,
    pub peer_id_safe: String,
    pub display_name: String,
    pub peer_tag: String,
    pub hub_id: String,
    pub reply_topic: String,
}

#[derive(Clone, Debug)]
struct PendingToastAction {
    event: KnockToastActionEvent,
    created_at: Instant,
}

#[derive(Default)]
struct ToastInner {
    next_action_seq: u64,
    active_owner_hub: Option<String>,
    pending_actions: Vec<PendingToastAction>,
    claimed_actions: HashMap<String, Instant>,
    recent_message_ids: HashMap<String, Instant>,
    recent_peer_alerts: HashMap<String, Instant>,
}

/// Thread-safe Rust state for cross-window knock notification deduplication and
/// atomic toast action routing between the `main` and `stream` windows.
#[derive(Default)]
pub struct ToastState {
    inner: Mutex<ToastInner>,
}

fn normalize_hub_id(hub_id: &str) -> String {
    hub_id.trim().to_ascii_lowercase()
}

fn build_peer_dedup_key(hub_id: &str, peer_id_safe: &str, display_name: &str) -> String {
    let norm_hub = normalize_hub_id(hub_id);
    let clean_peer = peer_id_safe.trim();
    let peer_part = if !clean_peer.is_empty() {
        clean_peer.to_ascii_lowercase()
    } else {
        format!("name:{}", display_name.trim().to_ascii_lowercase())
    };
    format!("{norm_hub}|{peer_part}")
}

fn prune_stale_entries(inner: &mut ToastInner, now: Instant) {
    inner
        .recent_message_ids
        .retain(|_, seen_at| now.saturating_duration_since(*seen_at) < MESSAGE_DEDUP_TTL);
    inner
        .recent_peer_alerts
        .retain(|_, seen_at| now.saturating_duration_since(*seen_at) < PEER_ALERT_DEDUP_TTL);
    inner
        .pending_actions
        .retain(|entry| now.saturating_duration_since(entry.created_at) < PENDING_ACTION_TTL);
    inner
        .claimed_actions
        .retain(|_, claimed_at| now.saturating_duration_since(*claimed_at) < CLAIMED_ACTION_TTL);
}

impl ToastState {
    fn with_inner<F, R>(&self, f: F) -> R
    where
        F: FnOnce(&mut ToastInner) -> R,
    {
        let mut guard = self
            .inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        f(&mut guard)
    }

    /// Atomically checks whether a native knock notification should be shown,
    /// suppressing duplicates across all windows by message ID and peer cooldown.
    pub fn try_begin_knock_notification(
        &self,
        hub_id: &str,
        peer_id_safe: &str,
        display_name: &str,
        message_id: Option<&str>,
    ) -> bool {
        self.try_begin_knock_notification_at(
            hub_id,
            peer_id_safe,
            display_name,
            message_id,
            Instant::now(),
        )
    }

    fn try_begin_knock_notification_at(
        &self,
        hub_id: &str,
        peer_id_safe: &str,
        display_name: &str,
        message_id: Option<&str>,
        now: Instant,
    ) -> bool {
        self.with_inner(|inner| {
            prune_stale_entries(inner, now);

            let clean_msg_id = message_id.map(str::trim).filter(|id| !id.is_empty());
            if let Some(msg_id) = clean_msg_id {
                if inner.recent_message_ids.contains_key(msg_id) {
                    return false;
                }
            }

            let peer_key = build_peer_dedup_key(hub_id, peer_id_safe, display_name);
            if inner.recent_peer_alerts.contains_key(&peer_key) {
                return false;
            }

            inner.recent_peer_alerts.insert(peer_key, now);
            if let Some(msg_id) = clean_msg_id {
                inner.recent_message_ids.insert(msg_id.to_string(), now);
            }
            true
        })
    }

    /// Marks `hub_id` as actively hosted inside the `stream` window.
    pub fn register_owner_room(&self, hub_id: &str) {
        let norm_hub = normalize_hub_id(hub_id);
        if norm_hub.is_empty() {
            return;
        }
        self.with_inner(|inner| {
            inner.active_owner_hub = Some(norm_hub);
        });
    }

    /// Clears the active owner room marker if it matches `hub_id`.
    pub fn unregister_owner_room(&self, hub_id: &str) {
        let norm_hub = normalize_hub_id(hub_id);
        self.with_inner(|inner| {
            if inner.active_owner_hub.as_deref() == Some(norm_hub.as_str()) {
                inner.active_owner_hub = None;
            }
        });
    }

    /// Clears any active owner room marker (e.g., when the `stream` window is destroyed).
    pub fn clear_active_owner_hub(&self) {
        self.with_inner(|inner| {
            inner.active_owner_hub = None;
        });
    }

    /// Assigns a unique action ID, queues background `accept` actions when no owner
    /// room is active, and returns the target window label (`"stream"` or `"main"`).
    fn prepare_toast_action_at(
        &self,
        action: &str,
        meta: &KnockToastActionEvent,
        now: Instant,
    ) -> (&'static str, KnockToastActionEvent) {
        self.with_inner(|inner| {
            prune_stale_entries(inner, now);

            inner.next_action_seq += 1;
            let mut payload = meta.clone();
            payload.action_id = format!("toast-action-{}", inner.next_action_seq);
            payload.action = action.to_string();

            let meta_hub = normalize_hub_id(&payload.hub_id);
            let room_is_active = matches!(
                &inner.active_owner_hub,
                Some(active) if meta_hub.is_empty() || active == &meta_hub
            );

            if room_is_active {
                ("stream", payload)
            } else {
                if payload.action == "accept" {
                    inner.pending_actions.retain(|entry| {
                        !(normalize_hub_id(&entry.event.hub_id) == meta_hub
                            && entry.event.peer_id_safe == payload.peer_id_safe)
                    });
                    inner.pending_actions.push(PendingToastAction {
                        event: payload.clone(),
                        created_at: now,
                    });
                }
                ("main", payload)
            }
        })
    }

    /// Drains pending toast actions queued for `hub_id` and marks them claimed so
    /// subsequent live-event handlers cannot replay them.
    fn consume_pending_actions_at(
        &self,
        hub_id: &str,
        now: Instant,
    ) -> Vec<KnockToastActionEvent> {
        let norm_hub = normalize_hub_id(hub_id);
        self.with_inner(|inner| {
            prune_stale_entries(inner, now);

            let mut matched = Vec::new();
            let mut remaining = Vec::with_capacity(inner.pending_actions.len());

            for entry in inner.pending_actions.drain(..) {
                let entry_hub = normalize_hub_id(&entry.event.hub_id);
                let is_match = norm_hub.is_empty() || entry_hub.is_empty() || entry_hub == norm_hub;
                if is_match {
                    if !entry.event.action_id.is_empty() {
                        inner
                            .claimed_actions
                            .insert(entry.event.action_id.clone(), now);
                    }
                    matched.push(entry.event);
                } else {
                    remaining.push(entry);
                }
            }

            inner.pending_actions = remaining;
            matched
        })
    }

    /// Atomically claims a toast `action_id` once, returning `false` if already claimed.
    fn claim_action_at(&self, action_id: &str, now: Instant) -> bool {
        let clean_id = action_id.trim();
        if clean_id.is_empty() {
            return true;
        }
        self.with_inner(|inner| {
            prune_stale_entries(inner, now);
            if inner.claimed_actions.contains_key(clean_id) {
                return false;
            }
            inner.claimed_actions.insert(clean_id.to_string(), now);
            inner
                .pending_actions
                .retain(|entry| entry.event.action_id != clean_id);
            true
        })
    }
}

#[cfg(target_os = "windows")]
fn ensure_toast_icon_file() -> Option<std::path::PathBuf> {
    let icon_path = std::env::temp_dir().join("elfy_toast_icon.png");
    if icon_path.exists() {
        return Some(icon_path);
    }
    let icon_bytes: &[u8] = include_bytes!("../icons/128x128.png");
    if std::fs::write(&icon_path, icon_bytes).is_ok() && icon_path.exists() {
        Some(icon_path)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn register_windows_aumid() {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let key = format!(r"HKCU\Software\Classes\AppUserModelId\{ELFY_AUMID}");
    let _ = std::process::Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["add", &key, "/v", "DisplayName", "/t", "REG_SZ", "/d", "Elfy", "/f"])
        .output();
    let _ = std::process::Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["add", &key, "/v", "IconBackgroundColor", "/t", "REG_SZ", "/d", "0", "/f"])
        .output();
    let _ = std::process::Command::new("reg")
        .creation_flags(CREATE_NO_WINDOW)
        .args(["add", &key, "/v", "ShowInSettings", "/t", "REG_DWORD", "/d", "1", "/f"])
        .output();
    if let Some(icon_path) = ensure_toast_icon_file() {
        let icon_uri = icon_path.to_string_lossy().into_owned();
        let _ = std::process::Command::new("reg")
            .creation_flags(CREATE_NO_WINDOW)
            .args(["add", &key, "/v", "IconUri", "/t", "REG_SZ", "/d", &icon_uri, "/f"])
            .output();
    }
}

/// Ensures the Windows AppUserModelId registry entry is written once per process.
#[cfg(target_os = "windows")]
pub fn init_windows_toast_aumid() {
    AUMID_INIT.call_once(register_windows_aumid);
}

fn focus_window_on_toast_open(app: &tauri::AppHandle, target_window: &str) {
    if target_window == "stream" {
        if let Some(stream_win) = app.get_webview_window("stream") {
            let _ = stream_win.unminimize();
            let _ = stream_win.show();
            let _ = stream_win.set_focus();
            return;
        }
    }
    if let Some(stream_win) = app.get_webview_window("stream") {
        if stream_win.is_visible().unwrap_or(false) {
            let _ = stream_win.unminimize();
            let _ = stream_win.show();
            let _ = stream_win.set_focus();
            return;
        }
    }
    if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.unminimize();
        let _ = main_win.show();
        let _ = main_win.set_focus();
    }
}

fn emit_knock_toast_action(
    app: &tauri::AppHandle,
    action: &str,
    meta: &KnockToastActionEvent,
) {
    let state = app.state::<ToastState>();
    let (target_window, payload) = state.prepare_toast_action_at(action, meta, Instant::now());
    if payload.action == "open" {
        focus_window_on_toast_open(app, target_window);
    }
    let _ = app.emit_to(target_window, "knock-toast-action", payload);
}

#[cfg(target_os = "windows")]
fn build_knock_winrt_toast(
    app_id: &str,
    title: &str,
    body: &str,
    icon_path: Option<&std::path::Path>,
    app: tauri::AppHandle,
    meta: KnockToastActionEvent,
    done_tx: std::sync::mpsc::SyncSender<()>,
) -> tauri_winrt_notification::Toast {
    use tauri_winrt_notification::{Duration, IconCrop, Scenario, Sound, Toast};

    let mut toast = Toast::new(app_id)
        .title(title)
        .text1(body)
        .text2("Click Allow to let them in, or Decline to dismiss.")
        .duration(Duration::Long)
        .scenario(Scenario::Reminder)
        .sound(Some(Sound::Default))
        .add_button("Allow", "accept")
        .add_button("Decline", "reject");

    if let Some(path) = icon_path {
        toast = toast.icon(path, IconCrop::Circular, "Elfy");
    }

    let activate_tx = done_tx.clone();
    toast = toast.on_activated(move |arg| {
        let resolved_action = match arg.as_deref() {
            Some("accept") => "accept",
            Some("reject") => "reject",
            _ => "open",
        };
        emit_knock_toast_action(&app, resolved_action, &meta);
        let _ = activate_tx.try_send(());
        Ok(())
    });

    toast.on_dismissed(move |_| {
        let _ = done_tx.try_send(());
        Ok(())
    })
}

#[cfg(target_os = "windows")]
fn spawn_powershell_balloon_fallback(
    app: &tauri::AppHandle,
    title: &str,
    body: &str,
    meta: &KnockToastActionEvent,
) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x08000000;

    let exe_path = std::env::current_exe()
        .ok()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default();

    let script = r#"
$ErrorActionPreference = 'Stop'
$title = $env:ELFY_NOTIFY_TITLE
$body = $env:ELFY_NOTIFY_BODY
$exePath = $env:ELFY_EXE_PATH
if ([string]::IsNullOrWhiteSpace($title)) { $title = 'Elfy' }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$icon = $null
if (-not [string]::IsNullOrWhiteSpace($exePath) -and (Test-Path -LiteralPath $exePath)) {
  try { $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($exePath) } catch { $icon = $null }
}
if ($null -eq $icon) {
  $icon = [System.Drawing.SystemIcons]::Information
}
$notify.Icon = $icon
$notify.Text = 'Elfy'
$notify.Visible = $true
$script:clicked = $false
$notify.add_BalloonTipClicked({
  $script:clicked = $true
  Write-Output 'ACTION:open'
})
$notify.ShowBalloonTip(7000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)
$deadline = [DateTime]::UtcNow.AddSeconds(7)
while (-not $script:clicked -and [DateTime]::UtcNow -lt $deadline) {
  [System.Windows.Forms.Application]::DoEvents()
  Start-Sleep -Milliseconds 100
}
$notify.Visible = $false
$notify.Dispose()
"#;

    if let Ok(output) = std::process::Command::new("powershell")
        .creation_flags(CREATE_NO_WINDOW)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            script,
        ])
        .env("ELFY_NOTIFY_TITLE", title)
        .env("ELFY_NOTIFY_BODY", body)
        .env("ELFY_EXE_PATH", exe_path)
        .output()
    {
        let stdout = String::from_utf8_lossy(&output.stdout);
        if stdout.contains("ACTION:open") {
            emit_knock_toast_action(app, "open", meta);
        }
    }
}

#[cfg(target_os = "windows")]
fn spawn_windows_toast_notification(
    app: tauri::AppHandle,
    title: String,
    body: String,
    meta: KnockToastActionEvent,
) {
    use tauri_winrt_notification::Toast;

    std::thread::spawn(move || {
        init_windows_toast_aumid();
        let icon_path = ensure_toast_icon_file();
        let (done_tx, done_rx) = std::sync::mpsc::sync_channel::<()>(4);

        let primary_toast = build_knock_winrt_toast(
            ELFY_AUMID,
            &title,
            &body,
            icon_path.as_deref(),
            app.clone(),
            meta.clone(),
            done_tx.clone(),
        );

        let active_toast = if let Err(primary_err) = primary_toast.show() {
            eprintln!("[Elfy Toast] Primary AUMID failed: {primary_err}");
            let fallback_toast = build_knock_winrt_toast(
                Toast::POWERSHELL_APP_ID,
                &title,
                &body,
                icon_path.as_deref(),
                app.clone(),
                meta.clone(),
                done_tx,
            );
            if let Err(fallback_err) = fallback_toast.show() {
                eprintln!("[Elfy Toast] PowerShell AUMID failed: {fallback_err}");
                spawn_powershell_balloon_fallback(&app, &title, &body, &meta);
                return;
            }
            fallback_toast
        } else {
            primary_toast
        };

        // Keep Toast and its COM TypedEventHandlers alive until activated/dismissed or timeout.
        let _ = done_rx.recv_timeout(Duration::from_secs(60));
        drop(active_toast);
    });
}

#[tauri::command]
pub fn show_knock_notification(
    app: tauri::AppHandle,
    state: State<'_, ToastState>,
    display_name: String,
    peer_tag: String,
    peer_id_safe: Option<String>,
    hub_id: Option<String>,
    reply_topic: Option<String>,
    message_id: Option<String>,
) -> Result<(), String> {
    let clean_name = display_name.trim();
    let clean_tag = peer_tag.trim();
    let caller = if clean_name.is_empty() {
        "Someone"
    } else {
        clean_name
    };
    let raw_peer_id = peer_id_safe.unwrap_or_default();
    let raw_hub_id = hub_id.unwrap_or_default();

    if !state.try_begin_knock_notification(
        &raw_hub_id,
        &raw_peer_id,
        caller,
        message_id.as_deref(),
    ) {
        return Ok(());
    }

    let title = "Elfy — Knock Request".to_string();
    let body = if clean_tag.is_empty() {
        format!("{caller} wants to join your Hub")
    } else {
        format!("{caller} ({clean_tag}) wants to join your Hub")
    };

    if let Some(stream_win) = app.get_webview_window("stream") {
        if stream_win.is_visible().unwrap_or(false) {
            let _ = stream_win.request_user_attention(Some(tauri::UserAttentionType::Informational));
        } else if let Some(main_win) = app.get_webview_window("main") {
            let _ = main_win.request_user_attention(Some(tauri::UserAttentionType::Informational));
        }
    } else if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }

    let meta = KnockToastActionEvent {
        action_id: String::new(),
        action: String::new(),
        peer_id_safe: raw_peer_id,
        display_name: caller.to_string(),
        peer_tag: clean_tag.to_string(),
        hub_id: raw_hub_id,
        reply_topic: reply_topic.unwrap_or_default(),
    };

    #[cfg(target_os = "windows")]
    spawn_windows_toast_notification(app, title, body, meta);

    #[cfg(not(target_os = "windows"))]
    {
        let _ = meta;
        use tauri_plugin_notification::NotificationExt;
        let _ = app
            .notification()
            .builder()
            .title(&title)
            .body(&body)
            .show();
    }

    Ok(())
}

#[tauri::command]
pub fn register_owner_room_session(state: State<'_, ToastState>, hub_id: String) {
    state.register_owner_room(&hub_id);
}

#[tauri::command]
pub fn unregister_owner_room_session(state: State<'_, ToastState>, hub_id: String) {
    state.unregister_owner_room(&hub_id);
}

#[tauri::command]
pub fn consume_pending_toast_actions(
    state: State<'_, ToastState>,
    hub_id: String,
) -> Vec<KnockToastActionEvent> {
    state.consume_pending_actions_at(&hub_id, Instant::now())
}

#[tauri::command]
pub fn claim_toast_action(state: State<'_, ToastState>, action_id: String) -> bool {
    state.claim_action_at(&action_id, Instant::now())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_meta(hub_id: &str, peer_id_safe: &str) -> KnockToastActionEvent {
        KnockToastActionEvent {
            action_id: String::new(),
            action: String::new(),
            peer_id_safe: peer_id_safe.to_string(),
            display_name: "Alex".to_string(),
            peer_tag: "Alex#1234".to_string(),
            hub_id: hub_id.to_string(),
            reply_topic: "elfy/inbox/alex_1234".to_string(),
        }
    }

    #[test]
    fn deduplicates_by_message_id_within_ttl_and_expires() {
        let state = ToastState::default();
        let t0 = Instant::now();

        assert!(state.try_begin_knock_notification_at(
            "elfy/hub/room1",
            "guest_1",
            "Guest",
            Some("msg-1"),
            t0,
        ));
        assert!(!state.try_begin_knock_notification_at(
            "elfy/hub/room1",
            "guest_1",
            "Guest",
            Some("msg-1"),
            t0 + Duration::from_millis(500),
        ));
        // Even with a different peer key, same message ID is deduplicated for 60s.
        assert!(!state.try_begin_knock_notification_at(
            "elfy/hub/room1",
            "guest_other",
            "Guest",
            Some("msg-1"),
            t0 + Duration::from_secs(10),
        ));
        // After TTL, the same message ID is accepted again.
        assert!(state.try_begin_knock_notification_at(
            "elfy/hub/room1",
            "guest_1",
            "Guest",
            Some("msg-1"),
            t0 + Duration::from_secs(61),
        ));
    }

    #[test]
    fn deduplicates_by_peer_within_cooldown_without_matching_message_id() {
        let state = ToastState::default();
        let t0 = Instant::now();

        assert!(state.try_begin_knock_notification_at(
            "ELFY/HUB/Room1",
            "guest_1",
            "Guest",
            None,
            t0,
        ));
        assert!(!state.try_begin_knock_notification_at(
            "elfy/hub/room1",
            "GUEST_1",
            "Guest",
            Some("msg-new"),
            t0 + Duration::from_secs(2),
        ));
        assert!(state.try_begin_knock_notification_at(
            "elfy/hub/room1",
            "guest_1",
            "Guest",
            Some("msg-after"),
            t0 + Duration::from_secs(4),
        ));
    }

    #[test]
    fn active_owner_room_routes_to_stream_and_allows_single_claim() {
        let state = ToastState::default();
        let t0 = Instant::now();
        state.register_owner_room("ELFY/HUB/Room1");

        // Unregistering a different hub leaves the active owner hub intact.
        state.unregister_owner_room("elfy/hub/other");

        let meta = sample_meta("elfy/hub/room1", "guest_1");
        let (target, event) = state.prepare_toast_action_at("accept", &meta, t0);
        assert_eq!(target, "stream");
        assert!(!event.action_id.is_empty());
        assert!(state.consume_pending_actions_at("elfy/hub/room1", t0).is_empty());

        assert!(state.claim_action_at(&event.action_id, t0));
        assert!(!state.claim_action_at(&event.action_id, t0));

        state.unregister_owner_room("elfy/hub/room1");
        let (next_target, _) = state.prepare_toast_action_at("reject", &meta, t0);
        assert_eq!(next_target, "main");
    }

    #[test]
    fn inactive_owner_room_queues_accept_and_consumes_atomically() {
        let state = ToastState::default();
        let t0 = Instant::now();
        let meta = sample_meta("elfy/hub/room1", "guest_1");

        let (t1, e1) = state.prepare_toast_action_at("accept", &meta, t0);
        assert_eq!(t1, "main");

        // A second accept for the same peer/hub replaces the stale queued accept.
        let (t2, e2) =
            state.prepare_toast_action_at("accept", &meta, t0 + Duration::from_millis(200));
        assert_eq!(t2, "main");
        assert_ne!(e1.action_id, e2.action_id);

        let consumed = state.consume_pending_actions_at("ELFY/HUB/room1", t0 + Duration::from_secs(1));
        assert_eq!(consumed.len(), 1);
        assert_eq!(consumed[0].action_id, e2.action_id);

        // Consuming again yields nothing and claiming the consumed action is rejected.
        assert!(state
            .consume_pending_actions_at("elfy/hub/room1", t0 + Duration::from_secs(1))
            .is_empty());
        assert!(!state.claim_action_at(&e2.action_id, t0 + Duration::from_secs(1)));
    }
}
