/**
 * Auto-inject the current Tauri webview window's label into every log entry.
 *
 * Per ADR-0014, multi-window logs (ADR-0011 — one Space per OS window) are
 * untangled by carrying `window_label` as a first-class field on every
 * event. The label is stable for the lifetime of the window, so we resolve
 * it lazily once and cache. The synchronous {@link getWindowLabel} returns
 * `"unknown"` until the underlying async import resolves (typically within
 * the first microtask after the first log call).
 */

let cachedLabel: string | undefined;
let initStarted = false;

/**
 * Returns the current window's label, or `"unknown"` if not yet resolved
 * (first call) or if running outside a Tauri webview context (e.g. vitest).
 *
 * The first call triggers a background dynamic import of
 * `@tauri-apps/api/webviewWindow`; once resolved, the label is cached and
 * subsequent calls return it synchronously without any await.
 */
export function getWindowLabel(): string {
  if (cachedLabel !== undefined) return cachedLabel;
  if (!initStarted) {
    initStarted = true;
    void resolveLabel();
  }
  return 'unknown';
}

/**
 * Resolve the label once and cache it.
 *
 * On any thrown error (no current webview, plugin missing, called outside
 * Tauri) we permanently cache `"unknown"` — retrying on every call would
 * just re-trigger the same failing import, wasting cycles. If the
 * environment genuinely cannot provide a label, every entry carrying
 * `window_label: "unknown"` is still correct, just less helpful.
 */
async function resolveLabel(): Promise<void> {
  try {
    const mod = await import('@tauri-apps/api/webviewWindow');
    const label = mod.getCurrentWebviewWindow().label;
    cachedLabel = label || 'unknown';
  } catch {
    cachedLabel = 'unknown';
  }
}
