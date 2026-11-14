mod db;
mod system_monitor;

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

#[tauri::command]
async fn open_stream_window(
    app: tauri::AppHandle,
    hub_id: Option<String>,
    auto_start: bool,
) -> Result<(), String> {
    let hub = hub_id.unwrap_or_default();
    let fragment = format!(
        "/stream?hubId={}&autoStart={}",
        urlencoding::encode(&hub),
        auto_start
    );

    if let Some(window) = app.get_webview_window("stream") {
        navigate_window_hash(&window, &fragment)?;
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
fn close_stream_window(app: tauri::AppHandle) -> Result<(), String> {
    let Some(window) = app.get_webview_window("stream") else {
        return Ok(());
    };
    let _ = window.hide();
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

#[tauri::command]
fn start_dragging(window: tauri::WebviewWindow) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
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
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            let _ = w.hide();
        }
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

fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let menu = MenuBuilder::new(app).build()?;
    let icon = tauri::include_image!("../public/elfy.ico");

    TrayIconBuilder::new()
        .icon(icon)
        .menu(&menu)
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
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_machine_uid::init())
        .setup(|app| {
            db::init_db(app.handle()).map_err(Box::<dyn std::error::Error>::from)?;
            system_monitor::init_monitor();
            configure_main_window(app).map_err(Box::<dyn std::error::Error>::from)?;
            configure_register_window(app);
            setup_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            show_register_window,
            close_register_window,
            open_stream_window,
            close_stream_window,
            hide_main_window,
            minimize_window,
            toggle_maximize_window,
            start_dragging,
            toggle_fullscreen,
            set_fullscreen,
            is_fullscreen,
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
