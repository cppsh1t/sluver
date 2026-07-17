use rusqlite::params;
use tauri::State;

use crate::db::{DbError, DbManager};
use crate::models::setting::{AppSetting, Appearance};

// ─── App Settings (meta.db settings table) ──────────────────────────────────

#[tauri::command]
pub fn get_app_setting(state: State<'_, DbManager>) -> Result<AppSetting, DbError> {
    state.with_meta(|conn| {
        let theme = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'appearance.theme'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "system".to_string());

        let color_theme = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'appearance.colorTheme'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "neutral".to_string());

        let locale = conn
            .query_row(
                "SELECT value FROM settings WHERE key = 'app.locale'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap_or_else(|_| "auto".to_string());

        Ok(AppSetting {
            appearance: Appearance { theme, color_theme },
            locale,
        })
    })
}

#[tauri::command]
pub fn update_app_setting(
    setting: AppSetting,
    state: State<'_, DbManager>,
) -> Result<AppSetting, DbError> {
    let theme = setting.appearance.theme.clone();
    let color_theme = setting.appearance.color_theme.clone();
    let locale = setting.locale.clone();
    state.with_meta(|conn| {
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('appearance.theme', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![theme],
        )?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('appearance.colorTheme', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![color_theme],
        )?;
        conn.execute(
            "INSERT INTO settings (key, value) VALUES ('app.locale', ?1)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![locale],
        )?;
        Ok(())
    })?;
    Ok(setting)
}
