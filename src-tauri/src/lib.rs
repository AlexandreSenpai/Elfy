mod db;
mod system_monitor;

use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Emitter, Manager, WindowEvent,
};
use tauri_plugin_positioner::{Position, WindowExt};

fn navigate_window_hash(window: &tauri::WebviewWindow, hash_path: &str) -> Result<(), String> {
    let mut current_url = window.url().map_err(|e| e.to_string())?;
    if current_url.fragment() == Some(hash_path) {
        return Ok(());
    }
    current_url.set_fragment(Some(hash_path));
    window.navigate(current_url).map_err(|e| e.to_string())
}

#[tauri::command]
fn show_register_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("register") {
        let _ = window.unminimize();
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        return navigate_window_hash(&window, "/register");
    }

    tauri::WebviewWindowBuilder::new(
        &app,
        "register",
        tauri::WebviewUrl::App("index.html#/register".into()),
    )
    .title("Elfy • Setup")
    .inner_size(580.0, 620.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .always_on_top(true)
    .build()
    .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let is_full = window.is_fullscreen().map_err(|e| e.to_string())?;
    let target = !is_full;
    window.set_fullscreen(target).map_err(|e| e.to_string())?;
    Ok(target)
}

#[tauri::command]
fn close_register_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("register") else {
        return Ok(());
    };
    let _ = window.hide();
    Ok(())
}

fn build_stream_fragment(
    hub_id: Option<String>,
    auto_start: bool,
    joined_as: Option<String>,
) -> String {
    let hub = hub_id.unwrap_or_default();
    let base = format!(
        "/stream?hubId={}&autoStart={}",
        urlencoding::encode(&hub),
        auto_start
    );

    match joined_as.as_deref() {
        Some("owner") => format!("{base}&joinedAs=owner"),
        Some("guest") => format!("{base}&joinedAs=guest"),
        _ => base,
    }
}

#[tauri::command]
async fn open_stream_window(
    app: tauri::AppHandle,
    hub_id: Option<String>,
    auto_start: bool,
    joined_as: Option<String>,
) -> Result<(), String> {
    let fragment = build_stream_fragment(hub_id, auto_start, joined_as);

    if let Some(window) = app.get_webview_window("stream") {
        navigate_window_hash(&window, &fragment)?;
        let _ = window.unminimize();
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
        return Ok(());
    }

    let app_url = format!("index.html#{fragment}");
    tauri::WebviewWindowBuilder::new(&app, "stream", tauri::WebviewUrl::App(app_url.into()))
        .title("Elfy Hub • Screen Share")
        .inner_size(1280.0, 720.0)
        .min_inner_size(800.0, 500.0)
        .decorations(false)
        .build()
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
fn restore_stream_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("stream") else {
        return Ok(());
    };
    let _ = window.unminimize();
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn close_stream_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("stream") {
        let _ = window.hide();
    }
    if let Some(main_win) = app.get_webview_window("main") {
        if !main_win.is_visible().unwrap_or(false) {
            let _ = main_win.as_ref().window().move_window(Position::TrayCenter);
            let _ = main_win.show();
            let _ = main_win.set_focus();
        }
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("main") else {
        return Ok(());
    };
    let _ = window.hide();
    Ok(())
}

#[tauri::command]
fn minimize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    let _ = window.minimize();
    Ok(())
}

#[tauri::command]
fn toggle_maximize_window(window: tauri::WebviewWindow) -> Result<(), String> {
    if window.is_maximized().unwrap_or(false) {
        let _ = window.unmaximize();
        return Ok(());
    }
    let _ = window.maximize();
    Ok(())
}

static MAIN_WINDOW_DRAGGING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);
static MAIN_DRAG_GUARD_UNTIL_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn now_epoch_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn is_cursor_inside_window(window: &tauri::WebviewWindow) -> bool {
    let Ok(cursor) = window.cursor_position() else {
        return false;
    };
    let Ok(pos) = window.outer_position() else {
        return false;
    };
    let Ok(size) = window.outer_size() else {
        return false;
    };

    let left = pos.x as f64;
    let top = pos.y as f64;
    let right = left + size.width as f64;
    let bottom = top + size.height as f64;
    cursor.x >= left && cursor.x <= right && cursor.y >= top && cursor.y <= bottom
}

#[tauri::command]
fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    let is_main = window.label() == "main";
    if is_main {
        MAIN_WINDOW_DRAGGING.store(true, std::sync::atomic::Ordering::SeqCst);
        MAIN_DRAG_GUARD_UNTIL_MS.store(
            now_epoch_ms().saturating_add(1500),
            std::sync::atomic::Ordering::SeqCst,
        );
    }

    let result = window.start_dragging().map_err(|e| e.to_string());

    if is_main {
        MAIN_DRAG_GUARD_UNTIL_MS.store(
            now_epoch_ms().saturating_add(500),
            std::sync::atomic::Ordering::SeqCst,
        );
        MAIN_WINDOW_DRAGGING.store(false, std::sync::atomic::Ordering::SeqCst);
        let _ = window.set_focus();
    }

    result
}

#[tauri::command]
fn set_fullscreen(window: tauri::WebviewWindow, fullscreen: bool) -> Result<(), String> {
    window.set_fullscreen(fullscreen).map_err(|e| e.to_string())
}

#[tauri::command]
fn is_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    window.is_fullscreen().map_err(|e| e.to_string())
}

fn configure_main_window(app: &tauri::App) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Main window not found".to_string())?;
    let w = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) => {
            MAIN_DRAG_GUARD_UNTIL_MS.store(
                now_epoch_ms().saturating_add(400),
                std::sync::atomic::Ordering::SeqCst,
            );
        }
        WindowEvent::Focused(false) => {
            let dragging = MAIN_WINDOW_DRAGGING.load(std::sync::atomic::Ordering::SeqCst);
            let guarded =
                now_epoch_ms() < MAIN_DRAG_GUARD_UNTIL_MS.load(std::sync::atomic::Ordering::SeqCst);
            if dragging || guarded || is_cursor_inside_window(&w) {
                let _ = w.set_focus();
                return;
            }
            let _ = w.hide();
        }
        _ => {}
    });
    Ok(())
}

fn configure_register_window(app: &tauri::App) {
    let Some(reg_win) = app.get_webview_window("register") else {
        return;
    };
    let reg_w = reg_win.clone();
    reg_win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = reg_w.hide();
        }
    });
}

fn configure_stream_window(app: &tauri::App) {
    let Some(stream_win) = app.get_webview_window("stream") else {
        return;
    };
    let stream_w = stream_win.clone();
    stream_win.on_window_event(move |event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = stream_w.hide();
        }
    });
}

fn toggle_main_window_visibility(app: &tauri::AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
        return;
    }
    let _ = window.as_ref().window().move_window(Position::TrayCenter);
    let _ = window.show();
    let _ = window.set_focus();
}

static INSTANCE_LOCK: std::sync::OnceLock<std::fs::File> = std::sync::OnceLock::new();

pub fn try_acquire_lock_file(path: &std::path::Path) -> Option<std::fs::File> {
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }

    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true);

    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.share_mode(0);
    }

    options.open(path).ok()
}

fn acquire_single_instance_lock() -> bool {
    if INSTANCE_LOCK.get().is_some() {
        return true;
    }

    let lock_path = std::env::temp_dir().join("elfy_single_instance.lock");
    let Some(file) = try_acquire_lock_file(&lock_path) else {
        return false;
    };

    let _ = INSTANCE_LOCK.set(file);
    true
}

#[cfg(target_os = "windows")]
const ELFY_AUMID: &str = "com.alexandresenpai.elfy";

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnockToastActionEvent {
    action: String,
    peer_id_safe: String,
    display_name: String,
    peer_tag: String,
    hub_id: String,
    reply_topic: String,
}

#[cfg(target_os = "windows")]
fn ensure_toast_icon_file() -> Option<std::path::PathBuf> {
    let icon_path = std::env::temp_dir().join("elfy_toast_icon.png");
    let icon_bytes: &[u8] = include_bytes!("../icons/128x128.png");
    if std::fs::write(&icon_path, icon_bytes).is_ok() && icon_path.exists() {
        return Some(icon_path);
    }
    if icon_path.exists() {
        Some(icon_path)
    } else {
        None
    }
}

#[cfg(target_os = "windows")]
fn ensure_windows_aumid_registered() {
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

fn focus_window_on_toast_open(app: &tauri::AppHandle) {
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
    let mut payload = meta.clone();
    payload.action = action.to_string();
    if payload.action == "open" {
        focus_window_on_toast_open(app);
    }
    let _ = app.emit("knock-toast-action", payload);
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
        .args(["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script])
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
        ensure_windows_aumid_registered();
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
        let _ = done_rx.recv_timeout(std::time::Duration::from_secs(60));
        drop(active_toast);
    });
}

#[tauri::command]
fn show_knock_notification(
    app: tauri::AppHandle,
    display_name: String,
    peer_tag: String,
    peer_id_safe: Option<String>,
    hub_id: Option<String>,
    reply_topic: Option<String>,
) -> Result<(), String> {
    let clean_name = display_name.trim();
    let clean_tag = peer_tag.trim();
    let caller = if clean_name.is_empty() { "Someone" } else { clean_name };
    let title = "Elfy — Knock Request".to_string();
    let body = if clean_tag.is_empty() {
        format!("{caller} wants to join your Hub")
    } else {
        format!("{caller} ({clean_tag}) wants to join your Hub")
    };

    if let Some(stream_win) = app.get_webview_window("stream") {
        let _ = stream_win.request_user_attention(Some(tauri::UserAttentionType::Informational));
    } else if let Some(main_win) = app.get_webview_window("main") {
        let _ = main_win.request_user_attention(Some(tauri::UserAttentionType::Informational));
    }

    let meta = KnockToastActionEvent {
        action: String::new(),
        peer_id_safe: peer_id_safe.unwrap_or_default(),
        display_name: caller.to_string(),
        peer_tag: clean_tag.to_string(),
        hub_id: hub_id.unwrap_or_default(),
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
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app)
        .text("open_elfy", "Open / Hide Elfy")
        .separator()
        .text("quit_elfy", "Close Elfy")
        .build()?;
    let icon = tauri::include_image!("../public/elfy.ico");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "open_elfy" => toggle_main_window_visibility(app),
            "quit_elfy" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::DoubleClick {
                button: MouseButton::Left,
                ..
            } = event
            {
                toggle_main_window_visibility(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if !acquire_single_instance_lock() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_machine_uid::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            #[cfg(target_os = "windows")]
            ensure_windows_aumid_registered();
            db::init_db(app.handle()).map_err(Box::<dyn std::error::Error>::from)?;
            system_monitor::init_monitor();
            configure_main_window(app).map_err(Box::<dyn std::error::Error>::from)?;
            configure_register_window(app);
            configure_stream_window(app);
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_register_window,
            close_register_window,
            open_stream_window,
            restore_stream_window,
            close_stream_window,
            hide_main_window,
            minimize_window,
            toggle_maximize_window,
            start_dragging,
            toggle_fullscreen,
            set_fullscreen,
            is_fullscreen,
            show_knock_notification,
            quit_app,
            db::db_get_or_init_profile,
            db::db_update_profile,
            db::db_set_telemetry_consent,
            db::db_list_friend_hubs,
            db::db_upsert_friend_hub,
            db::db_remove_friend_hub,
            system_monitor::get_system_metrics
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::try_acquire_lock_file;

    #[test]
    fn single_instance_lock_prevents_concurrent_holders() {
        let unique = format!(
            "elfy_lock_test_{}_{}.lock",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        );
        let lock_path = std::env::temp_dir().join(unique);

        {
            let first = try_acquire_lock_file(&lock_path);
            assert!(first.is_some(), "First instance must acquire the lock file");

            #[cfg(windows)]
            {
                let second = try_acquire_lock_file(&lock_path);
                assert!(
                    second.is_none(),
                    "Second instance must fail while first holds the exclusive lock"
                );
            }
        }

        let after_release = try_acquire_lock_file(&lock_path);
        assert!(
            after_release.is_some(),
            "Lock file must be acquirable after first instance releases it"
        );
        drop(after_release);
        let _ = std::fs::remove_file(&lock_path);
    }
}
