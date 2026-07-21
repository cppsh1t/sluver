//! Per-Space OS window management. Each Space opens in its own native
//! window (ADR-0011), providing natural state isolation without DOM
//! keep-alive hacks.
//!
//! ## Label convention
//!
//! Every Space window's label is `space-{uuid}`. The launcher window is the
//! statically-configured `"main"` from `tauri.conf.json`. Window labels are
//! charset-safe (UUID v7 contains only hex digits and dashes).
//!
//! ## Window lifecycle
//!
//! - **Creation**: [`ensure_space_window`] is idempotent — if the window
//!   exists, it's focused; otherwise a new frameless window is built with
//!   the Space name as its title and `/space/{id}` as the URL path (the
//!   frontend reads the id from the URL).
//! - **Close**: handled by the window-event router in `lib.rs`. Space
//!   windows close normally (and drop their cached `space.db` connections
//!   on `Destroyed`); the launcher hides to tray.

use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tauri_plugin_decorum::WebviewWindowExt;

use crate::db::{DbError, DbManager};

/// Window label convention: `space-{uuid}`.
pub fn space_window_label(space_id: &str) -> String {
    format!("space-{}", space_id)
}

/// Extract space_id from a window label, or `None` if not a Space window.
pub fn space_id_from_label(label: &str) -> Option<&str> {
    label.strip_prefix("space-")
}

/// Look up a Space's name from `meta.db`. Falls back to `"Sluver"` when the
/// row is missing or the DB layer is unavailable (must NEVER block window
/// creation or tray-menu build — the user can still see and dismiss the
/// resulting UI).
pub(crate) fn space_name(app: &AppHandle, space_id: &str) -> String {
    app.try_state::<DbManager>()
        .and_then(|state| {
            state
                .with_meta(|conn| {
                    Ok(conn
                        .query_row(
                            "SELECT name FROM spaces WHERE id = ?1",
                            rusqlite::params![space_id],
                            |row| row.get::<_, String>(0),
                        )
                        .ok())
                })
                .ok()
        })
        .flatten()
        .unwrap_or_else(|| "Sluver".to_string())
}

/// Convert a `tauri::Error` (from `WebviewWindowBuilder::build`,
/// `create_overlay_titlebar`, `set_traffic_lights_inset`, etc.) into a
/// [`DbError::Internal`]. Window creation is infrastructure — the dynamic
/// `tauri::Error` message reaches the user as an `INTERNAL_ERROR` fallback
/// (AGENTS.md §Internationalization) and isn't worth translating.
fn tauri_err(e: tauri::Error) -> DbError {
    DbError::Internal(e.to_string())
}

/// Create or focus a Space window. If the window already exists, bring it
/// to the front. If not, create it with the Space name as title.
///
/// The new window is frameless (`decorations(false)`) with a decorum overlay
/// titlebar (matching the launcher). It starts hidden and is shown only
/// after the overlay is in place, avoiding a flash of unstyled caption
/// controls. On macOS the traffic lights are inset to vertically center in
/// the custom titlebar.
///
/// Errors collapse to [`DbError::Internal`] via [`tauri_err`]; window
/// creation failures are infrastructure (no business semantics to translate).
pub fn ensure_space_window(app: &AppHandle, space_id: &str) -> Result<(), DbError> {
    let label = space_window_label(space_id);
    eprintln!("[ensure_space_window] called: space_id={space_id}, label={label}");

    // Single-instance: focus existing window.
    if let Some(window) = app.get_webview_window(&label) {
        eprintln!("[ensure_space_window] window exists — focusing");
        if let Err(e) = window.unminimize() {
            eprintln!("[ensure_space_window] unminimize failed: {e}");
        }
        if let Err(e) = window.show() {
            eprintln!("[ensure_space_window] show failed: {e}");
        }
        if let Err(e) = window.set_focus() {
            eprintln!("[ensure_space_window] set_focus failed: {e}");
        }
        return Ok(());
    }

    let space_name = space_name(app, space_id);
    eprintln!("[ensure_space_window] creating new window: title=Sluver — {space_name}");

    // Create new window. URL path `/space/{id}` lets the frontend router
    // identify which Space this window is for.
    let window = WebviewWindowBuilder::new(
        app,
        &label,
        WebviewUrl::App(format!("/space/{}", space_id).into()),
    )
    .title(format!("Sluver — {}", space_name))
    .inner_size(1280.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .decorations(false)
    .maximized(true)
    .visible(false)
    .build()
    .map_err(tauri_err)?;
    eprintln!("[ensure_space_window] window built: {label}");

    // Apply decorum overlay for frameless caption controls (same treatment
    // as the launcher window — see `lib.rs` setup).
    window.create_overlay_titlebar().map_err(tauri_err)?;
    eprintln!("[ensure_space_window] overlay titlebar created");

    #[cfg(target_os = "macos")]
    window
        .set_traffic_lights_inset(12.0, 12.0)
        .map_err(tauri_err)?;

    // Show after the overlay is wired up.
    window.show().map_err(tauri_err)?;
    window.set_focus().map_err(tauri_err)?;
    eprintln!("[ensure_space_window] window shown + focused");

    // Refresh tray menu so the new window appears in the list.
    crate::tray::refresh(app);
    eprintln!("[ensure_space_window] tray refreshed — done");

    Ok(())
}

/// Focus the launcher (main) window. Used by the tray menu and left-click.
///
/// Logs (via `eprintln!`) when the window can't be found or an operation
/// fails — these failures were previously swallowed by `let _ =`, which made
/// tray-click "nothing happens" symptoms impossible to distinguish from a
/// broken event handler. The `eprintln!` output appears in the `pnpm tauri
/// dev` terminal.
pub fn focus_launcher(app: &AppHandle) {
    match app.get_webview_window("main") {
        Some(w) => {
            if let Err(e) = w.unminimize() {
                eprintln!("[focus_launcher] unminimize failed: {e}");
            }
            if let Err(e) = w.show() {
                eprintln!("[focus_launcher] show failed: {e}");
            }
            if let Err(e) = w.set_focus() {
                eprintln!("[focus_launcher] set_focus failed: {e}");
            }
        }
        None => {
            // The "main" window is statically configured in tauri.conf.json
            // and protected from destruction by `prevent_close` in the
            // CloseRequested handler (see lib.rs). If it's somehow gone,
            // that's a real bug — log it loudly.
            eprintln!("[focus_launcher] main window not found — cannot focus launcher");
        }
    }
}
