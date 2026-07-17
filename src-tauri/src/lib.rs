mod commands;
mod db;
mod models;
mod tray;
mod util;

use tauri::{Emitter, Manager};
use tauri_plugin_decorum::WebviewWindowExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(data_dir.join("spaces"))?;
            let db_manager = db::DbManager::new(data_dir)?;
            app.manage(db_manager);

            // Frameless window: decorum injects native caption controls on
            // Windows/Linux (retaining Win11 Snap Layout). On macOS the native
            // traffic lights are preserved via titleBarStyle "Overlay" +
            // hiddenTitle in tauri.macos.conf.json.
            let main_window = app
                .get_webview_window("main")
                .expect("main window not found");
            main_window.create_overlay_titlebar()?;

            // macOS only: inset the traffic lights to vertically center them in
            // the custom titlebar (h-9 ≈ 36px). Tweak visually when targeting
            // macOS. No-op (not even compiled) on Windows/Linux.
            #[cfg(target_os = "macos")]
            main_window.set_traffic_lights_inset(12.0, 12.0)?;

            // System tray (close-to-tray + i18n menu). The tray starts with an
            // English menu; the frontend pushes the resolved locale via
            // `set_tray_locale` right after bootstrap. See `tray.rs`.
            tray::setup(app.handle())?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // World (meta.db)
            commands::world::create_world,
            commands::world::list_worlds,
            commands::world::get_world,
            commands::world::update_world,
            commands::world::delete_world,
            // App settings
            commands::setting::get_app_setting,
            commands::setting::update_app_setting,
            // Space (meta.db)
            commands::space::create_space,
            commands::space::list_spaces,
            commands::space::get_space,
            commands::space::update_space,
            commands::space::delete_space,
            commands::space::set_space_password,
            // Session (open/close/lock Space tabs)
            commands::session::get_session,
            commands::session::open_space,
            commands::session::close_space,
            commands::session::lock_space,
            commands::session::lock_all_protected_spaces,
            commands::session::set_active_space,
            // Character + Phase
            commands::character::create_character,
            commands::character::get_character,
            commands::character::list_characters,
            commands::character::update_character,
            commands::character::delete_character,
            commands::character::add_phase,
            commands::character::update_phase,
            commands::character::delete_phase,
            commands::character::reorder_phases,
            // Location
            commands::element::create_location,
            commands::element::get_location,
            commands::element::list_locations,
            commands::element::update_location,
            commands::element::delete_location,
            // Item
            commands::element::create_item,
            commands::element::get_item,
            commands::element::list_items,
            commands::element::update_item,
            commands::element::delete_item,
            // Lore
            commands::element::create_lore,
            commands::element::get_lore,
            commands::element::list_lores,
            commands::element::update_lore,
            commands::element::delete_lore,
            // Event
            commands::event::create_event,
            commands::event::get_event,
            commands::event::list_events,
            commands::event::update_event,
            commands::event::delete_event,
            commands::event::count_phase_refs,
            commands::event::count_character_refs,
            // Novel
            commands::novel::create_novel,
            commands::novel::get_novel,
            commands::novel::list_novels,
            commands::novel::update_novel,
            commands::novel::delete_novel,
            // Chapter
            commands::novel::create_chapter,
            commands::novel::get_chapter,
            commands::novel::list_chapters,
            commands::novel::update_chapter,
            commands::novel::delete_chapter,
            commands::novel::reorder_chapters,
            // Scene
            commands::novel::create_scene,
            commands::novel::get_scene,
            commands::novel::list_scenes,
            commands::novel::update_scene,
            commands::novel::delete_scene,
            commands::novel::reorder_scenes,
            // Tray
            commands::tray::set_tray_locale,
        ])
        .on_window_event(|window, event| {
            // Intercept the main window's close button: hide to tray instead
            // of tearing down the process. Only "main" is affected so future
            // auxiliary windows (dialogs, pickers, ...) can close normally.
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    // Hide-to-tray re-lock (ADR-0008): every protected Space
                    // drops its cached `space.db`/`world.db` connections and
                    // is marked locked in the persisted session, so restoring
                    // the window requires per-Space re-auth. Best-effort — a
                    // failure here must NEVER block the hide (the user still
                    // expects the window to vanish on close). The frontend
                    // listens for the `"spaces-locked"` event (T27) and
                    // invalidates its session cache to show the overlays.
                    //
                    // Order matters: lock → emit → hide. Emitting AFTER hide
                    // would race the webview teardown (T27).
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<crate::db::DbManager>() {
                        let _ = commands::session::lock_all_protected_spaces_impl(&state);
                    }
                    let _ = app.emit("spaces-locked", ());
                    let _ = window.hide();
                    api.prevent_close();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
