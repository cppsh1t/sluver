use tauri::AppHandle;

use crate::db::DbError;

/// Update the system tray menu labels to match a new UI locale.
///
/// `locale` is a resolved BCP-47 tag (e.g. `"zh-CN"`, `"en"`), NOT the
/// `"auto"` sentinel — the frontend resolves OS detection before calling
/// this. See `crate::tray::update_locale`.
#[tauri::command]
pub fn set_tray_locale(locale: String, app: AppHandle) -> Result<(), DbError> {
    crate::tray::update_locale(&app, &locale).map_err(|e| DbError::Internal(e.to_string()))
}
