//! System tray: icon + dynamic context menu.
//!
//! The menu lists every Space in the registry (ADR-0011, amended 2026-08-14:
//! previously only open windows were listed), marking those with an open
//! window with a checkmark, plus a launcher entry and a quit entry. The menu
//! is rebuilt (via [`refresh`]) whenever a Space window opens or closes, after
//! every tray click, and whenever the UI locale changes.
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
//! → focus that Space window, or open it through the ADR-0008 auth gate if
//! it isn't open yet; literal `"show"` → launcher; `"quit"` → exit). This
//! avoids trying to capture dynamic state in the closure.
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

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

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

/// Build the dynamic tray menu: one entry per Space in the registry (those
/// with an open window get a native checkmark), a separator, then launcher +
/// quit. Each Space item's id is `focus-space:{space_id}` so the
/// `on_menu_event` closure can route it without capturing dynamic state.
///
/// Spaces are read from `meta.db` (sorted by `created_at`); the checkmark is
/// derived from whether a `space-{id}` window currently exists. If the DB
/// read fails the Space section is simply skipped (launcher + quit still
/// render) — the tray must never block on a DB error.
fn build_menu(app: &AppHandle, locale: &str) -> tauri::Result<Menu<tauri::Wry>> {
    let menu = Menu::new(app)?;
    let mut space_count = 0u32;

    // One entry per Space in the registry (ADR-0011, amended). Open windows
    // get a checkmark so the user can tell which Spaces are already visible.
    if let Some(db) = app.try_state::<crate::db::DbManager>() {
        if let Ok(spaces) = crate::commands::space::do_list_spaces(&db) {
            for space in spaces {
                let is_open = app
                    .get_webview_window(&crate::window_manager::space_window_label(&space.id))
                    .is_some();
                let item = CheckMenuItem::with_id(
                    app,
                    format!("focus-space:{}", space.id),
                    space.name,
                    true,     // enabled
                    is_open,  // checked
                    None::<&str>,
                )?;
                menu.append(&item)?;
                space_count += 1;
            }
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
            if let Some(space_id) = id.strip_prefix("focus-space:") {
                // Open or focus the Space window. If the window doesn't
                // exist yet, FIRST route through the ADR-0008 auth gate:
                // `open_space_impl` with no password puts a protected Space
                // into the locked state (so the in-page password gate
                // renders) and is a harmless unlock + cache warm for an
                // unprotected one. This mirrors the startup path (lib.rs).
                // The gate is SKIPPED when the window already exists —
                // re-running the state machine on an open, unlocked
                // protected Space would re-lock it (gate over already-
                // visible content), since `was_locked == false` + no
                // password takes the locked-state-open branch.
                let label = crate::window_manager::space_window_label(space_id);
                if app.get_webview_window(&label).is_none() {
                    if let Some(db) = app.try_state::<crate::db::DbManager>() {
                        if let Err(e) =
                            crate::commands::session::open_space_impl(space_id, None, &db)
                        {
                            tracing::warn!(
                                error = %e,
                                entity_id = %space_id,
                                "tray space auth-gate failed"
                            );
                        }
                    }
                }
                // `ensure_space_window` focuses an existing window or builds
                // a new one (refreshing the tray on create so the new Space
                // shows its checkmark).
                if let Err(e) = crate::window_manager::ensure_space_window(app, space_id) {
                    tracing::warn!(
                        error = %e,
                        entity_id = %space_id,
                        "tray space window open failed"
                    );
                }
                // Re-derive checkmarks after the click. Covers the focus-
                // existing case (where `ensure_space_window` returns early
                // without refreshing) and neutralizes any OS-level auto-
                // toggle of the CheckMenuItem.
                refresh(app);
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
                crate::window_manager::focus_launcher(tray.app_handle());
            }
        })
        .build(app)?;
    tracing::info!("system tray initialized");
    Ok(())
}

/// Rebuild the tray menu with the stored locale, reflecting every Space in
/// the registry and which ones currently have an open window (checkmark).
/// Called whenever a Space window opens or closes (see the window-event
/// router in `lib.rs`) and after every tray Space click. Safe to call from
/// anywhere — it only touches the tray (via the app handle) and the DB read
/// lock.
pub fn refresh(app: &AppHandle) {
    let window_count = app.webview_windows().len() as u32;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let locale = current_locale();
        if let Ok(menu) = build_menu(app, &locale) {
            let _ = tray.set_menu(Some(menu));
        }
    }
    tracing::debug!(window_count = window_count, "tray menu refreshed");
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
