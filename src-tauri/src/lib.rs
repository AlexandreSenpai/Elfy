use tauri::{
    menu::MenuBuilder,
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent
};
use tauri_plugin_positioner::{Position, WindowExt};

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn show_register_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("register") {
        let _ = window.unminimize();
        let _ = window.center();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.eval("window.location.hash = '#/register';");
    } else {
        let _ = tauri::WebviewWindowBuilder::new(
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
        .build();
    }
    Ok(())
}

#[tauri::command]
fn toggle_fullscreen(window: tauri::WebviewWindow) -> Result<bool, String> {
    let is_fullscreen = window.is_fullscreen().map_err(|e| e.to_string())?;
    let target = !is_fullscreen;
    window.set_fullscreen(target).map_err(|e| e.to_string())?;
    Ok(target)
}

#[tauri::command]
fn close_register_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("register") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
async fn open_stream_window(app: tauri::AppHandle, hub_id: Option<String>, auto_start: bool) -> Result<(), String> {
    let hub = hub_id.unwrap_or_default();
    
    // Put the query parameters AFTER the hash route
    let url = format!("index.html#/stream?hubId={}&autoStart={}", urlencoding::encode(&hub), auto_start);

    if let Some(window) = app.get_webview_window("stream") {
        // If the window already exists, navigate it to the target hash URL
        window.eval(&format!("window.location.hash = '/stream?hubId={}&autoStart={}';", urlencoding::encode(&hub), auto_start))
            .map_err(|e| e.to_string())?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    } else {
        tauri::WebviewWindowBuilder::new(&app, "stream", tauri::WebviewUrl::App(url.into()))
            .title("Elfy Stream")
            .inner_size(1280.0, 720.0)
            .build()
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn close_stream_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("stream") {
        let _ = window.hide();
    }
    Ok(())
}

#[tauri::command]
fn hide_main_window(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
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
    } else {
        let _ = window.maximize();
    }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_positioner::init())
        .plugin(tauri_plugin_machine_uid::init())
        .setup(|app| {
            let window = app.get_webview_window("main").unwrap();
            let w = window.clone();

            window.on_window_event(move |event| {
                if let WindowEvent::Focused(false) = event {
                    let _ = w.hide();
                }
            });

            if let Some(reg_win) = app.get_webview_window("register") {
                let reg_w = reg_win.clone();
                reg_win.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = reg_w.hide();
                    }
                });
            }

            let menu = MenuBuilder::new(app).build().unwrap();
            let icon = tauri::include_image!("../public/elfy.ico");
            // let taskbar_icon = tauri::include_image!("../public/elfy-dock.png");

            // app.default_window_icon::

            let _tray = TrayIconBuilder::new()
                .icon(icon)
                .menu(&menu)
                .on_tray_icon_event(|tray, event| {
                    tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);

                    match event {
                        TrayIconEvent::DoubleClick {
                            button: MouseButton::Left,
                            ..
                        } => {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                if window.is_visible().unwrap_or(false) {
                                    let _ = window.hide();
                                } else {
                                    let _ = window
                                        .as_ref()
                                        .window()
                                        .move_window(Position::TrayCenter);
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                        }
                        _ => {}
                    }
                })
                .build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
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
            is_fullscreen
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
