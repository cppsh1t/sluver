//! System tray: icon + context menu with close-to-tray behavior.
//!
//! The menu labels are translated for `zh-CN` and `en`. The active locale is
//! pushed from the frontend via the `set_tray_locale` command (the frontend
//! already resolves the user preference + OS locale, so Rust stays dumb: it
//! just receives a resolved BCP-47 tag). At startup we default to `en` — the
//! menu is invisible until the user right-clicks the tray icon, so the
//! frontend's `set_tray_locale` call lands long before anyone sees a label.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

pub const TRAY_ID: &str = "main-tray";

/// Locale used until the frontend pushes the real one.
const STARTUP_LOCALE: &str = "en";

/// Collapse any BCP-47 tag to one of our two shipped translations. Mirrors
/// `resolveLocale` in `src/i18n/index.ts` (`zh*` → `zh-CN`, else `en`).
fn normalize_locale(raw: &str) -> &'static str {
    let lower = raw.to_lowercase();
    if lower.starts_with("zh") {
        "zh-CN"
    } else {
        "en"
    }
}

/// Tray menu label lookup. Hard-coded — the tray is OS-native UI, outside
/// React's i18next pipeline. Add a new language by adding a match arm.
fn label(locale: &str, key: &str) -> &'static str {
    match (normalize_locale(locale), key) {
        ("zh-CN", "show") => "显示主窗口",
        ("zh-CN", "quit") => "退出",
        ("en", "show") => "Show",
        ("en", "quit") => "Quit",
        _ => "",
    }
}

fn build_menu<R: Runtime>(app: &AppHandle<R>, locale: &str) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(app, "show", label(locale, "show"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", label(locale, "quit"), true, None::<&str>)?;
    Menu::with_items(app, &[&show, &quit])
}

/// Restore + focus the main window. Shared by the menu item and the
/// left-click handler.
fn show_main_window<R: Runtime>(app: &AppHandle<R>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Create the tray icon with the startup-locale menu. Called once from
/// `Builder::setup`.
pub fn setup<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let menu = build_menu(app, STARTUP_LOCALE)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().expect("missing app icon").clone())
        .tooltip("sluver")
        .menu(&menu)
        // Left-click restores the window directly; the context menu is still
        // reachable via right-click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show_main_window(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the tray menu with translated labels for `locale`. Called by the
/// `set_tray_locale` command — invoked from the frontend at bootstrap and on
/// language change.
pub fn update_locale<R: Runtime>(app: &AppHandle<R>, locale: &str) -> tauri::Result<()> {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_menu(app, locale)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
