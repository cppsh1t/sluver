# ADR-0054: Linux renders frontend caption buttons (decorum injection skipped)

**Status**: accepted (2026-09-19).

## Context

The frameless window chrome (ADR-0009) relies on `tauri-plugin-decorum` 1.1.1: `create_overlay_titlebar()` registers a Rust-side `decorum-page-load` listener that evals `titlebar.js` + a controls script into the page; our `WindowTitleBar` hosts the buttons via `data-tauri-decorum-tb`. On Windows this works and carries the Win11 Snap Layout hover (`decorum:allow-show-snap-overlay`); on macOS it is inert (native traffic lights). On Linux (WebKitGTK), the injected controls are broken in three independent ways, all confirmed in the crate source and on a KDE host:

1. **Dead empty first button.** The Linux path reads GNOME's `dconf` key `/org/gnome/desktop/wm/preferences/button-layout` and strips only the `appmenu:` prefix. KDE writes `icon:minimize,maximize,close` into the same key (for GTK app compatibility), so the first control id becomes `icon:minimize`, which matches no case in `createButton` — a button with no icon and no click handler is appended first in every set. This exactly matches the reported symptom: "the first one is an empty button, clicking does nothing".
2. **Duplicated button sets.** The Windows `controls.js` guards with `tbEl.querySelector(".decorum-tb-btn")` ("Controls already exist. Skipping creation."); `linux-controls.js` has no such guard and appends a fresh `.decorum-tb-actions` group on every execution. Meanwhile Tauri v2 fires the plugin's `on_page_load` hook twice per load (`Committed` → Started, `Finished` → Finished) and decorum re-emits `decorum-page-load` as a **global broadcast** — every window's listener evals on its own window for every page load of every window. Any broadcast landing while a document is still in `readyState === "loading"` (routine in dev, where the Vite module graph delays `DOMContentLoaded` while other windows load) appends another full set.
3. **Broken minimize handler.** `linux-controls.js`'s minimize click calls `clearTimeout(timer)` with no `timer` declared in that file (it exists only in the Windows script), throwing `ReferenceError` before `win.minimize()`.

Net effect on Linux: multiple copies of the caption group, each led by a dead empty button. Windows is unaffected (guard + native `button-layout` absence), which is why the bug surfaced only when running on Linux.

## Decision

- **Rust skips `create_overlay_titlebar()` on Linux** (`#[cfg(not(target_os = "linux"))]` in `lib.rs` setup and `window_manager.rs::ensure_space_window`, with the `WebviewWindowExt` import gated the same way). No decorum script is injected on Linux, so nothing can append foreign caption buttons. Windows and macOS paths are byte-identical to before.
- **The frontend renders its own caption buttons on Linux** inside `WindowTitleBar`: minimize / maximize-restore / close via `getCurrentWindow()` from `@tauri-apps/api/window` (`core:window:allow-*` permissions already present in capabilities), maximize state tracked through `onResized` + `isMaximized()`. Platform detection uses `platform()` from `@tauri-apps/plugin-os`, which is synchronous (injected before app code runs), resolved once per window document. Close goes through `Window.close()`, so the Rust `CloseRequested` routing (launcher hides to tray, Space windows close normally) is unchanged.
- Drag is unaffected: it was never decorum's on this layout — `data-tauri-drag-region` on our element plus `core:window:allow-start-dragging` already handle it on all platforms.

## Consequences

- Linux gets caption buttons themed with the app's design tokens (`bg-accent` hover, destructive close hover) instead of decorum's fixed white circular chips — an improvement on light themes. They follow locale via `common:window.*` aria-labels.
- The Linux buttons lose nothing functional relative to the (broken) injected ones: decorum's Linux script never had snap-layout hover (Windows-only) and its minimize was dead anyway.
- `decorum:allow-show-snap-overlay` stays in capabilities (Windows still uses it).
- Upstream decorum fixes could later make the Linux injection viable again, but we would still prefer our own buttons for theming; this divergence is a product choice, not just a workaround.

## Alternatives considered

- **Patch/fork decorum** (`[patch.crates-io]` git dep): rejected — supply-chain complexity and a permanently divergent fork for a problem we can route around entirely, plus the fixed injection would still render unthemable white chips.
- **Keep decorum on Linux and sanitize client-side** (remove injected nodes via MutationObserver): rejected — fighting an injector that re-runs on every page-load broadcast is fragile; the empty-button and ReferenceError bugs live in the injected script's own handlers.
- **Drop decorum everywhere**: rejected — Windows keeps real value (Win11 Snap Layout hover on maximize, native-feeling caption rendering); macOS uses it for traffic-light inset.

## References

- ADR-0009 (workspace shell / frameless chrome this builds on)
- `tauri-plugin-decorum` 1.1.1 source: `src/lib.rs` (page-load broadcast re-eval), `src/js/linux-controls.js` (no idempotency guard; undeclared `timer`; dconf prefix parsing), `src/js/controls.js` (the Windows guard Linux lacks)
- wry 0.55.1 `src/webkitgtk/mod.rs` (Committed→Started, Finished→Finished double hook)
- `src/components/window-title-bar.tsx` (the Linux caption button implementation)
