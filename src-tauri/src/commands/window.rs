//! Window commands — bridge between frontend IPC and [`crate::window_manager`].
//!
//! The frontend opens a Space window by invoking `open_space_window` with the
//! Space id. The window manager handles single-instance focusing + creation
//! details; this module just exposes the operation as a Tauri command.

use std::sync::mpsc;

use tauri::AppHandle;

use crate::db::DbError;

/// Open (or focus) the OS window for a Space (ADR-0011).
///
/// **MUST be `async` + dispatch via `run_on_main_thread`** — creating a
/// `WebviewWindow` on Windows requires the main thread (WebView2 boot path).
/// A synchronous `#[tauri::command]` fn runs ON the main thread and blocks
/// its event loop; if it calls `WebviewWindowBuilder::build()` (which
/// internally posts to the main-thread event loop and blocks on the reply),
/// the post never gets serviced → **deadlock**. The SpacePicker becomes
/// unresponsive, caption buttons stop working (the main thread is wedged),
/// and the tray menu stops processing clicks.
///
/// Making the command `async` moves it off the main thread onto tokio's
/// runtime. `run_on_main_thread` then schedules `ensure_space_window` on the
/// main thread's event loop, which is free to process it. We use a
/// `std::sync::mpsc` channel to ferry the `Result` back to the async caller.
///
/// The startup path in `lib.rs` doesn't hit this because it already uses
/// `run_on_main_thread` (the closure runs after `setup` returns, when the
/// main thread is idle).
#[tauri::command]
pub async fn open_space_window(space_id: String, app: AppHandle) -> Result<(), DbError> {
    let (tx, rx) = mpsc::channel::<Result<(), DbError>>();
    let app_for_main = app.clone();

    app.run_on_main_thread(move || {
        let result = crate::window_manager::ensure_space_window(&app_for_main, &space_id);
        let _ = tx.send(result);
    })
    .map_err(|e| DbError::Internal(e.to_string()))?;

    // Block on the channel — the main thread will process the closure,
    // run `ensure_space_window` (which calls `WebviewWindowBuilder::build`
    // directly on the main thread — no re-entrancy), and send back the
    // result. This recv is on a tokio worker thread, not the main thread.
    rx.recv()
        .map_err(|_| DbError::Internal("main thread dropped the channel sender before sending a result".to_string()))?
}

