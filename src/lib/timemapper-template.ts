/**
 * Default TimeMapper template shown to users when they first open the mapper
 * editor.
 *
 * This is NOT i18n material — it is executable JavaScript with English
 * comments, copied verbatim into the user's editor and shipped as the seed for
 * external AI assistance (ChatGPT / Claude web). Per ADR-0026 it is plain JS
 * (browsers cannot run TypeScript) executed via Blob + dynamic `import()` in
 * an isolated Web Worker.
 */

export const DEFAULT_TEMPLATE = `/**
 * TimeMapper — converts an ISO 8601 timestamp into this World's
 * custom time representation.
 *
 * Contract:
 *   Input:    iso — an ISO 8601 string, e.g. "2024-03-15T10:30:00Z"
 *   Returns:  a display string in your World's time format
 *
 * Execution environment:
 *   - Pure JavaScript (no TypeScript syntax).
 *   - Synchronous only — no async/await, fetch, import, or require.
 *   - Runs in an isolated Web Worker with a 50ms timeout.
 *   - new Date(iso) is available for parsing.
 *   - No access to DOM, window, localStorage, or Tauri APIs.
 *
 * Default output: "YYYY-MM-DD HH:mm:ss" (UTC).
 *   e.g. "2024-03-15T10:30:00Z" → "2024-03-15 10:30:00".
 * Replace the body below to implement your World's custom calendar.
 *
 * Need help? Copy this entire file (comments + code), paste it into
 * ChatGPT or Claude with a description of your world's time system,
 * then paste the result back here.
 */

export default function format(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) {
    return iso; // unparsable input — return as-is
  }
  const pad = (n) => String(n).padStart(2, "0");
  return (
    d.getUTCFullYear() +
    "-" +
    pad(d.getUTCMonth() + 1) +
    "-" +
    pad(d.getUTCDate()) +
    " " +
    pad(d.getUTCHours()) +
    ":" +
    pad(d.getUTCMinutes()) +
    ":" +
    pad(d.getUTCSeconds())
  );
}
`;
