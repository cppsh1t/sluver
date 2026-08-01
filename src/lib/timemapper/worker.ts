/// <reference lib="WebWorker" />

/**
 * TimeMapper Web Worker (ADR-0026).
 *
 * Executes user-authored JavaScript in an isolated context. The client
 * (`./client.ts`) feeds it mapper source via a Blob URL + dynamic `import()`,
 * then asks it to render ISO timestamps into the World's custom time format.
 *
 * All watchdog / timeout handling lives in the CLIENT — this worker is pure
 * request/response. The protocol carries no correlation id, so at most one
 * round-trip may be in flight at a time (enforced by the client's
 * serialization chain).
 *
 * Protocol:
 *   inbound  compile { code } → outbound compiled | error(syntax)
 *   inbound  format  { iso }  → outbound result   | error(runtime)
 *
 * No DOM, window, localStorage, or Tauri APIs are reachable here — only the
 * pure JS runtime (`Date`, `Math`, …) plus Blob/URL/import for loading the
 * mapper module.
 */

export type InboundMessage =
  | { type: "compile"; code: string }
  | { type: "format"; iso: string };

export type OutboundMessage =
  | { type: "compiled" }
  | { type: "result"; iso: string; display: string }
  | { type: "error"; kind: "syntax"; message: string }
  | { type: "error"; kind: "runtime"; message: string; iso: string };

// Cast through `unknown` to sidestep the DOM-vs-WebWorker `self` ambiguity
// (this file pulls in both libs; skipLibCheck tolerates the duplicate globals).
const scope = self as unknown as DedicatedWorkerGlobalScope;

/**
 * Compiled mapper entry point, or `null` when nothing is compiled yet / the
 * last module had no `default` export. A `null` mapper makes `format` fall
 * back to returning the raw ISO string.
 */
let formatFn: ((iso: string) => unknown) | null = null;

/** Currently outstanding Blob object URL, revoked on recompile. */
let blobUrl: string | null = null;

function revokeBlobUrl(): void {
  if (blobUrl !== null) {
    URL.revokeObjectURL(blobUrl);
    blobUrl = null;
  }
}

function post(message: OutboundMessage): void {
  scope.postMessage(message);
}

async function handleCompile(code: string): Promise<void> {
  // Drop the previously compiled module before importing the new one so the
  // old Blob URL never leaks across recompiles.
  revokeBlobUrl();

  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  blobUrl = url;
  try {
    const mod = (await import(url)) as { default?: unknown };
    const fn = mod.default;
    if (typeof fn !== "function") {
      revokeBlobUrl();
      formatFn = null;
      post({ type: "error", kind: "syntax", message: "Default export must be a function" });
      return;
    }
    formatFn = fn as (iso: string) => unknown;
    post({ type: "compiled" });
  } catch (e) {
    // Dynamic import failure: syntax error, bad export, etc.
    revokeBlobUrl();
    formatFn = null;
    post({ type: "error", kind: "syntax", message: String(e) });
  }
}

function handleFormat(iso: string): void {
  if (formatFn === null) {
    // Nothing compiled (or missing default export) → render raw ISO.
    post({ type: "result", iso, display: iso });
    return;
  }
  try {
    const display = formatFn(iso);
    post({ type: "result", iso, display: String(display) });
  } catch (e) {
    post({ type: "error", kind: "runtime", message: String(e), iso });
  }
}

scope.onmessage = (event: MessageEvent<InboundMessage>) => {
  const msg = event.data;
  if (msg.type === "compile") {
    void handleCompile(msg.code);
    return;
  }
  handleFormat(msg.iso);
};
