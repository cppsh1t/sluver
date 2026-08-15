//! Native OS notification command (ADR-0036).
//!
//! Sends toasts via `notify-rust` directly instead of
//! `tauri-plugin-notification`:
//!
//! - The plugin's desktop `show()` deliberately skips the AppUserModelID
//!   when the exe lives under `target/{debug,release}` (dev builds), falling
//!   back to notify-rust's default — the Windows PowerShell AUMID. Windows 11
//!   24H2+ silently drops toasts sent under that AUMID (anti-abuse measure),
//!   so dev-build notifications never render there.
//! - The plugin also swallows send failures at three layers (spawned task +
//!   `let _ =` + unit-return command), making breakage undiagnosable.
//!
//! Our command always tags toasts with the app's bundle identifier and
//! propagates errors, so both dev and installed builds render reliably and
//! failures surface to the frontend.

use tauri::AppHandle;

use crate::db::DbError;

/// Show a native OS notification.
///
/// `title`/`body` are skipped from the tracing span on purpose: they carry
/// user-facing (potentially creative-adjacent) content — only the command
/// name is logged (ADR-0016 redaction policy).
#[tauri::command]
#[tracing::instrument(skip(app, title, body))]
pub fn show_notification(app: AppHandle, title: String, body: String) -> Result<(), DbError> {
    let identifier = app.config().identifier.clone();
    notify_rust::Notification::new()
        .app_id(&identifier)
        .summary(&title)
        .body(&body)
        .show()
        .map_err(|e| DbError::Internal(format!("notification failed: {e}")))?;
    tracing::debug!("notify.notification_shown");
    Ok(())
}

/// Best-effort, idempotent Windows AUMID self-registration (ADR-0036).
///
/// A WinRT toast only renders when its AppUserModelID is known to the
/// notification platform. For an unpackaged (non-MSIX) app that means:
///
/// 1. `SetCurrentProcessExplicitAppUserModelID` — pin this process to the
///    bundle identifier.
/// 2. `HKCU\Software\Classes\AppUserModelId\{id}` with a `DisplayName`
///    (+ `IconUri`) — lets toasts render with the app name/icon even when
///    no installer-created Start Menu shortcut exists (dev builds, portable
///    runs, or a repaired install that dropped the shortcut property).
///
/// Re-written on every launch, so a shortcut that lost its registration
/// self-heals. Failures are logged and swallowed — notifications are a UX
/// nicety and must never block startup.
#[cfg(windows)]
pub fn register_aumid(app: &AppHandle) {
    use std::ffi::OsStr;
    use std::os::windows::ffi::OsStrExt;

    let identifier = app.config().identifier.clone();
    let display_name = app.package_info().name.clone();

    // 1. Pin the process to the AUMID.
    // SAFETY: `wide` is NUL-terminated (we chain a 0); the function only
    // reads the string during the call.
    extern "system" {
        fn SetCurrentProcessExplicitAppUserModelID(app_id: *const u16) -> i32;
    }
    let wide: Vec<u16> = OsStr::new(&identifier)
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let hr = unsafe { SetCurrentProcessExplicitAppUserModelID(wide.as_ptr()) };
    if hr != 0 {
        tracing::warn!(hr, "notify.aumid.set_process_failed");
    }

    // 2. Register DisplayName + IconUri so the toast renders with app
    //    branding even without an installed shortcut.
    use winreg::enums::HKEY_CURRENT_USER;
    use winreg::RegKey;
    let hkcu = RegKey::predef(HKEY_CURRENT_USER);
    let path = format!(r"Software\Classes\AppUserModelId\{identifier}");
    match hkcu.create_subkey(&path) {
        Ok((key, _)) => {
            let _ = key.set_value("DisplayName", &display_name);
            if let Ok(exe) = std::env::current_exe() {
                let _ = key.set_value("IconUri", &exe.to_string_lossy().to_string());
            }
            tracing::info!("notify.aumid.registered");
        }
        Err(e) => {
            tracing::warn!(error = %e, "notify.aumid.register_failed");
        }
    }
}

#[cfg(not(windows))]
pub fn register_aumid(_app: &AppHandle) {}
