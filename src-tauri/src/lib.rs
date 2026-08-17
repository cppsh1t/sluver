mod commands;
mod db;
mod export;
mod logging;
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
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_decorum::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;
            std::fs::create_dir_all(data_dir.join("spaces"))?;

            // Logging foundation (ADR-0014 / ADR-0015 / ADR-0016). MUST be
            // initialized before any subsystem that emits `tracing`/`log`
            // events — i.e. before DbManager, which constructs rusqlite
            // pools that emit log records. The `LoggingState` is managed
            // for the app lifetime so its `WorkerGuard` survives until
            // shutdown (dropping it flushes + joins the writer thread).
            // `cleanup_old_logs` runs best-effort and never propagates.
            std::fs::create_dir_all(data_dir.join("logs"))?;
            let logging_state = logging::init(&data_dir)?;
            app.manage(logging_state);
            logging::cleanup_old_logs(&data_dir, logging::DEFAULT_RETENTION_DAYS);

            tracing::info!(
                app_version = env!("CARGO_PKG_VERSION"),
                os = std::env::consts::OS,
                arch = std::env::consts::ARCH,
                "sluver starting"
            );

            let db_manager = db::DbManager::new(data_dir)?;
            app.manage(db_manager);

            // Agent shell execution kill registry (ADR-0041): maps runId →
            // kill handle for in-flight `shell_exec` runs. In-memory only —
            // nothing is persisted. Entries are removed by a drop guard on
            // the run's blocking thread, so they cannot leak.
            app.manage(commands::shell::ShellRegistry::default());

            // Re-apply persisted verbosity tier (settings.app.logLevel).
            // Best-effort: any failure (missing row, corrupted/unrecognized
            // value, reload error) is logged and swallowed so app startup is
            // never blocked by a corrupted setting. The bootstrap default
            // from `logging::init` keeps running on any failure path. See
            // ADR-0014. MUST run AFTER both LoggingState and DbManager are
            // managed (we need both to read the setting and apply the filter).
            if let (Some(logging_state), Some(db_manager)) = (
                app.try_state::<logging::LoggingState>(),
                app.try_state::<db::DbManager>(),
            ) {
                reapply_persisted_log_level(&logging_state, &db_manager);
            }

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

            // Native notifications: self-register the Windows AUMID so
            // toasts render in dev builds too (ADR-0036). Best-effort.
            commands::notification::register_aumid(app.handle());

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
                        // Enforce the ADR-0008 auth gate on the auto-opened
                        // startup Space. This path used to open the window
                        // directly WITHOUT running the lock state machine, so
                        // a protected Space whose entry in `locked_space_ids`
                        // had been lost — via a process kill, a crash, or
                        // closing the Space window directly instead of going
                        // through the launcher's hide-to-tray — was shown
                        // without a password prompt. Routing the id through
                        // `open_space_impl` with no password puts a protected
                        // Space into the locked state (its id is added to
                        // `locked_space_ids`, cache NOT warmed); for an
                        // unprotected Space this is a harmless unlock + cache
                        // warm. This mirrors the explicit-open path
                        // (`useOpenSpaceInWindow` → `openSpace` then
                        // `openSpaceWindow`) and self-corrects regardless of
                        // how `locked_space_ids` was left by the prior run.
                        //
                        // Runs synchronously here, BEFORE the window is
                        // created (window creation is deferred to the event
                        // loop via `run_on_main_thread`), so the locked state
                        // is persisted before the frontend gate reads the
                        // session — no race. Best-effort: a failure is logged
                        // but never blocks the window open.
                        if let Err(e) =
                            commands::session::open_space_impl(&space_id, None, &db_manager)
                        {
                            tracing::warn!(
                                error = %e,
                                entity_id = %space_id,
                                "startup space lock-enforce failed"
                            );
                        }
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
            // World cover image (space.db registry)
            commands::world::update_world_image,
            commands::world::clear_world_image,
            commands::world::get_world_image,
            // World export / import (.sluver-world zip archive)
            commands::world::export_world,
            commands::world::import_world,
            // App settings
            commands::setting::get_app_setting,
            commands::setting::update_app_setting,
            // System fonts (settings font pickers)
            commands::font::list_system_fonts,
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
            // Character / Phase image
            commands::character::update_character_image,
            commands::character::clear_character_image,
            commands::character::get_character_image,
            commands::character::update_phase_image,
            commands::character::clear_phase_image,
            commands::character::get_phase_image,
            // Location
            commands::element::create_location,
            commands::element::get_location,
            commands::element::list_locations,
            commands::element::update_location,
            commands::element::delete_location,
            commands::element::update_location_image,
            commands::element::clear_location_image,
            commands::element::get_location_image,
            // Item
            commands::element::create_item,
            commands::element::get_item,
            commands::element::list_items,
            commands::element::update_item,
            commands::element::delete_item,
            commands::element::update_item_image,
            commands::element::clear_item_image,
            commands::element::get_item_image,
            // Lore
            commands::element::create_lore,
            commands::element::get_lore,
            commands::element::list_lores,
            commands::element::update_lore,
            commands::element::delete_lore,
            commands::element::update_lore_image,
            commands::element::clear_lore_image,
            commands::element::get_lore_image,
            // Event
            commands::event::create_event,
            commands::event::get_event,
            commands::event::list_events,
            commands::event::update_event,
            commands::event::delete_event,
            commands::event::count_phase_refs,
            commands::event::count_character_refs,
            // Event image
            commands::event::update_event_image,
            commands::event::clear_event_image,
            commands::event::get_event_image,
            // Novel
            commands::novel::create_novel,
            commands::novel::get_novel,
            commands::novel::list_novels,
            commands::novel::update_novel,
            commands::novel::delete_novel,
            // Novel image
            commands::novel::update_novel_image,
            commands::novel::clear_novel_image,
            commands::novel::get_novel_image,
            // Chapter
            commands::novel::create_chapter,
            commands::novel::get_chapter,
            commands::novel::get_chapter_overview,
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
            // Scene gallery images (1:N — scene_images sidecar, WORLD_MIGRATION_008)
            commands::novel::add_scene_image,
            commands::novel::delete_scene_image,
            commands::novel::reorder_scene_images,
            commands::novel::get_scene_image,
            commands::novel::list_scene_image_ids,
            // Novel export (TXT / EPUB file generation)
            commands::export_book::export_novel,
            // Conversation (world-scoped chat — ADR-0022)
            commands::conversation::list_conversations,
            commands::conversation::create_conversation,
            commands::conversation::delete_conversation,
            commands::conversation::load_messages,
            commands::conversation::append_messages,
            commands::conversation::update_conversation_plan,
            commands::conversation::update_conversation_title,
            // World config (TimeMapper — ADR-0026)
            commands::world_config::get_time_mapper,
            commands::world_config::set_time_mapper,
            // Tray
            commands::tray::set_tray_locale,
            // AI config (space.db)
            commands::ai::list_provider_credentials,
            commands::ai::set_provider_credential,
            commands::ai::delete_provider_credential,
            commands::ai::list_agent_configs,
            commands::ai::update_agent_config_model,
            commands::ai::update_agent_config_auto_execute,
            commands::ai::update_agent_config_context_compaction,
            commands::ai::update_agent_config_system_prompt,
            commands::ai::update_agent_config_shell_tool,
            commands::ai::get_models_dev_catalog,
            commands::ai::refresh_models_dev_catalog,
            commands::search::search_web,
            commands::search::fetch_url,
            commands::search::fetch_url_via_webview,
            // Image-from-URL pipeline (download + center-crop + resize + WebP).
            // Used by agent `set_<entity>_image_from_url` tools.
            commands::search::fetch_and_prepare_image,
            // Diagnostics (logging — ADR-0014 / ADR-0015)
            commands::diagnostics::frontend_log,
            commands::diagnostics::get_log_level,
            commands::diagnostics::set_log_level,
            commands::diagnostics::get_logs_dir,
            commands::diagnostics::export_logs,
            commands::diagnostics::clear_logs,
            // World entity summaries + search (lightweight IPC for agent tools)
            commands::world_search::list_character_summaries,
            commands::world_search::search_characters,
            commands::world_search::list_location_summaries,
            commands::world_search::search_locations,
            commands::world_search::list_item_summaries,
            commands::world_search::search_items,
            commands::world_search::list_lore_summaries,
            commands::world_search::search_lores,
            commands::world_search::list_event_summaries,
            commands::world_search::search_events,
            commands::world_search::list_novel_summaries,
            commands::world_search::search_novels,
            commands::world_search::list_chapter_summaries,
            commands::world_search::search_chapters,
            commands::world_search::list_scene_summaries,
            commands::world_search::search_scenes,
            // grep (match-centric full-corpus retrieval — ADR-0035)
            commands::grep::grep,
            // Notes (single-table Folder/Note tree — ADR-0038; agent access
            // prompt-gated per ADR-0037)
            commands::note::create_note,
            commands::note::get_note,
            commands::note::list_notes,
            commands::note::update_note,
            commands::note::delete_note,
            commands::note::reorder_notes,
            commands::note::move_note,
            commands::note::grep_notes,
            // Timeline (derived view — ADR-0033)
            commands::timeline::query_timeline,
            commands::timeline::list_timeline_lanes,
            // Native notifications (notify-rust + explicit AUMID — ADR-0036)
            commands::notification::show_notification,
            // Agent shell execution (deno_task_shell — ADR-0041)
            commands::shell::shell_exec,
            commands::shell::shell_kill,
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
                    tracing::info!(
                        window = "main",
                        event = "close_requested_hide_to_tray",
                        "main window hiding to tray"
                    );
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
                    tracing::info!(
                        window = %label,
                        event = "destroyed",
                        "space window destroyed"
                    );
                    let app = window.app_handle();
                    let space_id = space_id.to_string();
                    if let Some(state) = app.try_state::<crate::db::DbManager>() {
                        state.close_space(&space_id);
                    }
                    crate::tray::refresh(app);

                    // NOTE (ADR-0011): closing the last Space window does NOT
                    // auto-show the launcher. The app stays dormant in the
                    // tray (launcher hidden, `lastOpenedSpaceId` preserved);
                    // the user returns via the tray menu's "Open Launcher" or
                    // by relaunching the app (which reopens
                    // `lastOpenedSpaceId`). Do NOT re-add a `main.show()` on
                    // last-close — it was a bug.
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

/// Read the persisted verbosity tier (`settings.app.logLevel`) from
/// `meta.db` and re-apply it to the live `EnvFilter` (ADR-0014).
///
/// # Why this exists
///
/// `logging::init` always bootstraps the subscriber from `RUST_LOG` or
/// [`logging::DEFAULT_FILTER`]; it does NOT consult the persisted tier. Without
/// this re-application, a user who picks "Very verbose", restarts the app,
/// and reopens Settings would see "Very verbose" selected (the dialog reads
/// from the same row we read here) while the runtime filter is silently still
/// at the default tier. The UI would lie about the active filter.
///
/// # Failure semantics (best-effort, never fatal)
///
/// App startup MUST succeed regardless of what's in `meta.db`. Every failure
/// path is logged and swallowed so the bootstrap default stays active:
///   - Missing row (first run) → no-op, no log (default stays — nothing was
///     persisted).
///   - Unrecognized tier value → `tracing::warn!`, default stays.
///   - Reload failure → `tracing::warn!`, default stays (the reload handle
///     keeps the prior filter on failure, which here is the default).
///   - `meta.db` read failure → `tracing::warn!`, default stays.
///
/// # Single source of truth
///
/// Uses [`logging::tier_to_filter`] so the tier→filter mapping is shared with
/// `commands::diagnostics::set_log_level` (the runtime-change path). The two
/// paths cannot drift.
fn reapply_persisted_log_level(
    logging_state: &logging::LoggingState,
    db_manager: &db::DbManager,
) {
    // Read the persisted tier. `query_row` errors (most commonly
    // `QueryReturnedNoRows` on a fresh install) collapse to `None` via
    // `.ok()` so the match below treats any read failure as "no tier" —
    // indistinguishable from a first run, which is the correct UX.
    let tier_result: Result<Option<String>, db::DbError> = db_manager.with_meta(|conn| {
        let tier: Option<String> = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app.logLevel'",
                rusqlite::params![],
                |row| row.get::<_, String>(0),
            )
            .ok();
        Ok(tier)
    });

    match tier_result {
        Ok(Some(tier)) => match logging::tier_to_filter(&tier) {
            Some(filter) => match logging_state.reload_filter_str(filter) {
                Ok(()) => tracing::info!(
                    persisted_tier = %tier,
                    filter = %filter,
                    "re-applied persisted log level"
                ),
                Err(e) => tracing::warn!(
                    error = %e,
                    persisted_tier = %tier,
                    "failed to re-apply persisted log level"
                ),
            },
            None => tracing::warn!(
                persisted_tier = %tier,
                "unrecognized persisted log level, falling back to default"
            ),
        },
        Ok(None) => {
            // First run — no row yet. Default filter stays. No log needed
            // (this is the expected state on a fresh install).
        }
        Err(e) => tracing::warn!(error = %e, "failed to read persisted log level"),
    }
}
