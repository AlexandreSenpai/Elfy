mod db;
mod system_monitor;
mod toast;

use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
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

static REGISTER_WINDOW_LOCK: std::sync::OnceLock<tauri::async_runtime::Mutex<()>> =
    std::sync::OnceLock::new();
static REGISTER_OPEN_GUARD_UNTIL_MS: std::sync::atomic::AtomicU64 =
    std::sync::atomic::AtomicU64::new(0);

fn register_window_mutex() -> &'static tauri::async_runtime::Mutex<()> {
    REGISTER_WINDOW_LOCK.get_or_init(|| tauri::async_runtime::Mutex::new(()))
}

#[tauri::command]
async fn show_register_window(app: tauri::AppHandle) -> Result<(), String> {
    let _guard = register_window_mutex().lock().await;
    REGISTER_OPEN_GUARD_UNTIL_MS.store(
        now_epoch_ms().saturating_add(1200),
        std::sync::atomic::Ordering::SeqCst,
    );

    if let Some(window) = app.get_webview_window("register") {
        let _ = window.unminimize();
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        return navigate_window_hash(&window, "/register");
    }

    // Must run in an async command on Windows: synchronous WebviewWindowBuilder::build()
    // deadlocks WebView2 COM creation against the Win32 main thread message pump.
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
    .visible(false)
    .center()
    .on_page_load(|window, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let _ = window.center();
            let _ = window.show();
            let _ = window.set_focus();
        }
    })
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
async fn close_register_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("register") else {
        return Ok(());
    };
    let _ = window.close();
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

fn is_sibling_window_active(app: &tauri::AppHandle) -> bool {
    if now_epoch_ms() < REGISTER_OPEN_GUARD_UNTIL_MS.load(std::sync::atomic::Ordering::SeqCst) {
        return true;
    }
    ["register", "stream"].iter().any(|label| {
        app.get_webview_window(label)
            .is_some_and(|win| win.is_visible().unwrap_or(false) && win.is_focused().unwrap_or(false))
    })
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
            if is_sibling_window_active(w.app_handle()) {
                return;
            }
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

fn configure_stream_window(app: &tauri::App) {
    let Some(stream_win) = app.get_webview_window("stream") else {
        return;
    };
    let stream_w = stream_win.clone();
    stream_win.on_window_event(move |event| {
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = stream_w.hide();
            }
            WindowEvent::Destroyed => {
                if let Some(toast_state) = stream_w.try_state::<toast::ToastState>() {
                    toast_state.clear_active_owner_hub();
                }
            }
            _ => {}
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
            toast::init_windows_toast_aumid();
            let db_state = db::init_db(app.handle()).map_err(Box::<dyn std::error::Error>::from)?;
            app.manage(db_state);
            app.manage(toast::ToastState::default());
            system_monitor::init_monitor();
            configure_main_window(app).map_err(Box::<dyn std::error::Error>::from)?;
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
            toast::show_knock_notification,
            toast::register_owner_room_session,
            toast::unregister_owner_room_session,
            toast::consume_pending_toast_actions,
            toast::claim_toast_action,
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
