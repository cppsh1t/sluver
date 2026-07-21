//! Window commands — bridge between frontend IPC and [`crate::window_manager`].
//!
//! The frontend opens a Space window by invoking `open_space_window` with the
//! Space id. The window manager handles single-instance focusing + creation
//! details; this module just exposes the operation as a Tauri command.

use tauri::AppHandle;

use crate::db::DbError;

/// Open (or focus) the OS window for a Space (ADR-0011).
///
/// Errors propagate as [`DbError::Internal`] (collapsing to `INTERNAL_ERROR`
/// on the frontend) — window creation is infrastructure, not a business-
/// domain error.
#[tauri::command]
pub fn open_space_window(space_id: String, app: AppHandle) -> Result<(), DbError> {
    crate::window_manager::ensure_space_window(&app, &space_id)
}
