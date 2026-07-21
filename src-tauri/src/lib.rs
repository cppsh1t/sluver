mod commands;
mod db;
mod models;
mod tray;
mod util;
mod window_manager;

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

            // Decide which window to show on startup (ADR-0011). Priority:
            //   1. lastOpenedSpaceId (if the Space still exists)
            //   2. first Space in the registry (sorted by created_at)
            //   3. launcher (main window) — no Spaces at all
            // The main window starts hidden (tauri.conf.json visible:false).
            // We show it only as a fallback. When a Space window opens, main
            // stays hidden. `WebviewWindowBuilder::build` has main-thread
            // affinity on Windows (WebView2 boot path), so we hop to the main
            // thread instead of spawning on the tokio runtime. The outer
            // `let _ =` swallows any dispatch error: if the window can't
            // auto-open (process is shutting down, main thread is saturated),
            // the user can still open it from the launcher — this is a UX
            // nicety, not a correctness invariant.
            let app_handle = app.handle().clone();
            if let Some(db_manager) = app.try_state::<db::DbManager>() {
                match determine_startup_space(&db_manager) {
                    Some(space_id) => {
                        let app_for_thread = app_handle.clone();
                        let _ = app_handle.run_on_main_thread(move || {
                            let _ =
                                window_manager::ensure_space_window(&app_for_thread, &space_id);
                        });
                    }
                    None => {
                        // No Spaces at all → show the launcher.
                        if let Some(main_window) = app_handle.get_webview_window("main") {
                            let _ = main_window.show();
                            let _ = main_window.set_focus();
                        }
                    }
                }
            }

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
            // Session (open/lock Space tabs)
            commands::session::get_session,
            commands::session::open_space,
            commands::session::lock_space,
            commands::session::lock_all_protected_spaces,
            // Window (per-Space OS windows — ADR-0011)
            commands::window::open_space_window,
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
            let label = window.label();

            if label == "main" {
                // Launcher window: hide-to-tray instead of tearing down the
                // process. Hide-to-tray re-lock (ADR-0008): every protected
                // Space drops its cached `space.db`/`world.db` connections
                // and is marked locked in the persisted session, so restoring
                // the window requires per-Space re-auth. Best-effort — a
                // failure here must NEVER block the hide (the user still
                // expects the window to vanish on close). The frontend
                // listens for the `"spaces-locked"` event (T27) and
                // invalidates its session cache to show the overlays.
                //
                // Order matters: lock → emit → hide. Emitting AFTER hide
                // would race the webview teardown (T27).
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let app = window.app_handle();
                    if let Some(state) = app.try_state::<crate::db::DbManager>() {
                        let _ = commands::session::lock_all_protected_spaces_impl(&state);
                    }
                    let _ = app.emit("spaces-locked", ());
                    let _ = window.hide();
                    api.prevent_close();
                }
            } else if let Some(space_id) = crate::window_manager::space_id_from_label(label) {
                // Space window: close normally. On Destroyed (after the
                // webview is torn down), drop this Space's cached DB
                // connections so the file handles don't linger, and refresh
                // the tray menu (the window is no longer listed).
                if let tauri::WindowEvent::Destroyed = event {
                    let app = window.app_handle();
                    let space_id = space_id.to_string();
                    if let Some(state) = app.try_state::<crate::db::DbManager>() {
                        state.close_space(&space_id);
                    }
                    crate::tray::refresh(app);

                    // If this was the last Space window, show the launcher so
                    // the user can pick or create a new Space. At this point
                    // `webview_windows()` no longer includes the just-destroyed
                    // window, so any remaining `space-*` label means another
                    // Space is still open.
                    let has_space_windows = app
                        .webview_windows()
                        .keys()
                        .any(|k| crate::window_manager::space_id_from_label(k).is_some());
                    if !has_space_windows {
                        if let Some(main_window) = app.get_webview_window("main") {
                            let _ = main_window.show();
                            let _ = main_window.set_focus();
                        }
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Determine which Space to open on startup (ADR-0011). Returns `None` if
/// there are no Spaces at all — caller should show the launcher.
///
/// Priority:
///   1. `lastOpenedSpaceId` from the persisted session, IF that Space still
///      exists in the registry (defensive against stale ids — the session row
///      is normally evicted on delete, but a hand-edited DB or a partially-
///      failed delete could leave a dangling id).
///   2. The first Space by `created_at` (`do_list_spaces` sorts ascending).
fn determine_startup_space(db: &db::DbManager) -> Option<String> {
    let session = commands::session::get_session_impl(db).ok()?;
    let spaces = commands::space::do_list_spaces(db).ok()?;

    // 1. lastOpenedSpaceId (if it still exists in the registry)
    if let Some(id) = session.last_opened_space_id {
        if spaces.iter().any(|s| s.id == id) {
            return Some(id);
        }
    }

    // 2. First Space by created_at (do_list_spaces already sorts by created_at)
    spaces.first().map(|s| s.id.clone())
}
