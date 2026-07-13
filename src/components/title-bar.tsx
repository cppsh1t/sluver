/**
 * Custom frameless titlebar — a full-width drag region.
 *
 * Window controls (minimize / maximize / close) are NOT rendered here. They are
 * provided natively by `tauri-plugin-decorum`:
 *   - Windows/Linux: decorum injects native caption buttons (top-right) which
 *     retain the Win11 Snap Layout flyout. Style via `#decorum-tb-*` in CSS.
 *   - macOS: native traffic lights sit top-left (titleBarStyle "Overlay" +
 *     hiddenTitle in tauri.macos.conf.json; decorum insets them to align).
 *
 * `data-tauri-drag-region` makes the whole bar draggable; double-clicking it
 * toggles maximize (built-in Tauri behavior).
 */
export function TitleBar() {
  return (
    <div
      data-tauri-drag-region
      className="h-9 shrink-0 border-b border-sidebar-border bg-sidebar"
    />
  );
}
