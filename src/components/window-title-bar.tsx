/**
 * Minimal frameless title bar — drag region + decorum caption button host.
 *
 * `data-tauri-decorum-tb` is the escape hatch (decorum docs Pattern 2 / Issue
 * #41): when decorum's `titlebar.js` finds an existing element with this
 * attribute, it skips creating its own z-index:100 overlay and instead mounts
 * the caption buttons (minimize/maximize/close) INSIDE our element via
 * `controls.js`. This avoids the two-overlay conflict (Issue #32) where our
 * opaque drag region swallowed clicks meant for decorum's buttons.
 *
 * `data-tauri-drag-region` stays on the outer div — since decorum no longer
 * creates its own drag div, we must provide drag ourselves. Tauri v2's drag
 * region does NOT intercept clicks on interactive descendants (`<button>`),
 * so decorum's caption buttons work correctly inside this container.
 *
 * Each Space opens in its own OS window (ADR-0009, superseded the browser-style
 * tab bar); this title bar replaces that. macOS traffic lights are positioned
 * separately via `set_traffic_lights_inset` in Rust — no frontend change needed.
 */
export function WindowTitleBar() {
  return (
    <div
      data-tauri-decorum-tb
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-center justify-end bg-background"
    >
      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-xs font-medium tracking-wide text-muted-foreground/50">
        Sluver
      </span>
      {/* decorum's controls.js appends caption <button> elements here on DOMContentLoaded */}
    </div>
  );
}
