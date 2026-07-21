/**
 * Minimal frameless title bar — drag region only (ADR-0011).
 *
 * Replaces the browser-style tab bar (ADR-0009, superseded). Each Space
 * now opens in its own OS window, so there are no tabs to render.
 *
 * Decorum's `create_overlay_titlebar()` (called from `lib.rs` on every
 * window) injects the native close/minimize/maximize buttons as an overlay
 * on the right (Windows/Linux) or left (macOS). This component only needs
 * to provide a drag region and leave space for the overlay — no buttons.
 *
 * `data-tauri-drag-region` is safe here because the title bar contains
 * NO interactive children (unlike the old TitleBar which had tab/close
 * buttons that conflicted with the drag region).
 */
export function WindowTitleBar() {
  return (
    <div
      className="flex h-9 shrink-0 items-center justify-center bg-background"
      data-tauri-drag-region
    >
      <span className="pointer-events-none select-none text-xs font-medium tracking-wide text-muted-foreground/50">
        Sluver
      </span>
    </div>
  );
}
