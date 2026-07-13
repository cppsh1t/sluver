mod commands;
mod db;
mod models;
mod util;

use tauri::Manager;
use tauri_plugin_decorum::WebviewWindowExt;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(data_dir.join("worlds"))?;
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

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // World (meta.db)
            commands::world::create_world,
            commands::world::list_worlds,
            commands::world::get_world,
            commands::world::update_world,
            commands::world::delete_world,
            // App config
            commands::world::get_app_config,
            commands::world::update_app_config,
            // Character + Phase
            commands::character::create_character,
            commands::character::get_character,
            commands::character::list_characters,
            commands::character::update_character,
            commands::character::delete_character,
            commands::character::add_phase,
            commands::character::update_phase,
            commands::character::delete_phase,
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
            // Novel
            commands::novel::create_novel,
            commands::novel::get_novel,
            commands::novel::list_novels,
            commands::novel::update_novel,
            commands::novel::delete_novel,
            // Chapter
            commands::novel::create_chapter,
            commands::novel::get_chapter,
            commands::novel::update_chapter,
            commands::novel::delete_chapter,
            commands::novel::reorder_chapters,
            // Scene
            commands::novel::create_scene,
            commands::novel::get_scene,
            commands::novel::update_scene,
            commands::novel::delete_scene,
            commands::novel::reorder_scenes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
