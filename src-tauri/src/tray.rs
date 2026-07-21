//! System tray: icon + dynamic context menu.
//!
//! The menu lists every open Space window (ADR-0011), plus a launcher entry
//! and a quit entry. The menu is rebuilt (via [`refresh`]) whenever a Space
//! window opens or closes, and whenever the UI locale changes.
//!
//! ## Locale
//!
//! Menu labels are translated for `zh-CN` and `en`. The active locale is
//! pushed from the frontend via the `set_tray_locale` command (the frontend
//! already resolves the user preference + OS locale, so Rust stays dumb: it
//! just receives a resolved BCP-47 tag). At startup we default to `en` —
//! the menu is invisible until the user right-clicks the tray icon, so the
//! frontend's `set_tray_locale` call lands long before anyone sees a label.
//! The pushed locale is stored in a global `Mutex<String>` so [`refresh`]
//! (which may be called from anywhere without the original locale argument)
//! picks up the most recent value.
//!
//! ## Event routing
//!
//! The `on_menu_event` handler is registered ONCE at setup time and routes
//! dynamic items by parsing the menu item id string (prefix `focus-space:`
//! → focus that Space window; literal `"show"` → launcher; `"quit"` → exit).
//! This avoids trying to capture dynamic state in the closure.
//!
//! ## Why concrete `AppHandle` (no `<R: Runtime>`)
//!
//! `window_manager` and the Tauri command layer use concrete `AppHandle`
//! (= `AppHandle<Wry>`). Keeping the tray generic would force every call
//! site (including the `on_menu_event` closure, which routes to
//! `window_manager::focus_launcher`) to commit to a single runtime anyway.
//! Going concrete everywhere removes an unnecessary generic that nothing in
//! this app actually parameterizes.

use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

// `space_name` is shared with `window_manager` (which owns the window-label
// ↔ Space mapping conceptually); re-export it here so this module has a
// single canonical name-lookup path.
use crate::window_manager::space_name;

pub const TRAY_ID: &str = "main-tray";

/// Locale used until the frontend pushes the real one.
const STARTUP_LOCALE: &str = "en";

/// The most recent locale pushed via [`update_locale`]. Empty until the
/// frontend pushes a value, in which case [`current_locale`] falls back to
/// [`STARTUP_LOCALE`]. `Mutex::new` in a `static` is const since Rust 1.63.
static CURRENT_LOCALE: Mutex<String> = Mutex::new(String::new());

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
        ("zh-CN", "launcher") => "打开主面板",
        ("zh-CN", "quit") => "退出",
        ("en", "launcher") => "Open Launcher",
        ("en", "quit") => "Quit",
        _ => "",
    }
}

/// Return the locale to use for menu labels right now: the most recently
/// pushed locale if any, else [`STARTUP_LOCALE`].
fn current_locale() -> String {
    let guard = CURRENT_LOCALE.lock().expect("CURRENT_LOCALE poisoned");
    if guard.is_empty() {
        STARTUP_LOCALE.to_string()
    } else {
        guard.clone()
    }
}

/// Build the dynamic tray menu: one entry per open Space window, a
/// separator, then launcher + quit. Each Space item's id is
/// `focus-space:{space_id}` so the `on_menu_event` closure can route it
/// without capturing dynamic state.
fn build_menu(app: &AppHandle, locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let mut space_count = 0u32;

    // One menu item per open Space window.
    for label_str in app.webview_windows().keys() {
        if let Some(space_id) = crate::window_manager::space_id_from_label(label_str) {
            let name = space_name(app, space_id);
            let item = MenuItem::with_id(
                app,
                format!("focus-space:{}", space_id),
                name,
                true,
                None::<&str>,
            )?;
            menu.append(&item)?;
            space_count += 1;
        }
    }

    // Separator between Space items and the app-level actions.
    if space_count > 0 {
        let sep = PredefinedMenuItem::separator(app)?;
        menu.append(&sep)?;
    }

    let launcher =
        MenuItem::with_id(app, "show", label(locale, "launcher"), true, None::<&str>)?;
    menu.append(&launcher)?;
    let quit = MenuItem::with_id(app, "quit", label(locale, "quit"), true, None::<&str>)?;
    menu.append(&quit)?;

    Ok(menu)
}

/// Create the tray icon with the startup-locale menu. Called once from
/// `Builder::setup`.
pub fn setup(app: &AppHandle) -> tauri::Result<()> {
    let menu = build_menu(app, STARTUP_LOCALE)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(app.default_window_icon().expect("missing app icon").clone())
        .tooltip("sluver")
        .menu(&menu)
        // Left-click restores the launcher window directly; the context
        // menu is still reachable via right-click.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            // Diagnostic: confirms the handler fires. If you see this line in
            // the `pnpm tauri dev` terminal after clicking a menu item, the
            // tray plumbing is healthy — look elsewhere (usually the action).
            eprintln!("[tray] menu event: {id}");
            if let Some(space_id) = id.strip_prefix("focus-space:") {
                // Focus the corresponding Space window.
                let label = crate::window_manager::space_window_label(space_id);
                match app.get_webview_window(&label) {
                    Some(w) => {
                        if let Err(e) = w.unminimize() {
                            eprintln!("[tray] focus-space unminimize failed: {e}");
                        }
                        if let Err(e) = w.show() {
                            eprintln!("[tray] focus-space show failed: {e}");
                        }
                        if let Err(e) = w.set_focus() {
                            eprintln!("[tray] focus-space set_focus failed: {e}");
                        }
                    }
                    None => {
                        eprintln!("[tray] space window not found: {label}");
                    }
                }
            } else {
                match id {
                    "show" => crate::window_manager::focus_launcher(app),
                    "quit" => app.exit(0),
                    _ => {}
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                eprintln!("[tray] left-click → focus_launcher");
                crate::window_manager::focus_launcher(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

/// Rebuild the tray menu with the stored locale, reflecting the current set
/// of open Space windows. Called whenever a Space window opens or closes
/// (see the window-event router in `lib.rs`). Safe to call from anywhere —
/// it only touches the tray (via the app handle) and the DB read lock.
pub fn refresh(app: &AppHandle) {
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let locale = current_locale();
        if let Ok(menu) = build_menu(app, &locale) {
            let _ = tray.set_menu(Some(menu));
        }
    }
}

/// Rebuild the tray menu with translated labels for `locale`, and store the
/// locale so subsequent [`refresh`] calls pick it up. Called by the
/// `set_tray_locale` command — invoked from the frontend at bootstrap and
/// on language change.
pub fn update_locale(app: &AppHandle, locale: &str) -> tauri::Result<()> {
    {
        let mut guard = CURRENT_LOCALE.lock().expect("CURRENT_LOCALE poisoned");
        *guard = locale.to_string();
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let menu = build_menu(app, locale)?;
        tray.set_menu(Some(menu))?;
    }
    Ok(())
}
