/**
 * TimeMapper client singleton (ADR-0026).
 *
 * Owns: the Web Worker lifecycle, lazy-loading of per-World mapper code,
 * a per-ISO result cache, and the 50ms watchdog.
 *
 * Bound to the current World via {@link init} (called on World entry). Call
 * {@link reloadMapper} when the user saves new mapper source. The public
 * façade in `./format` delegates here.
 *
 * Watchdog note: timeouts are managed HERE, never inside the worker. On a
 * timeout the worker is terminated and recreated; the mapper is recompiled
 * into the fresh worker on the next `format` call so a one-off infinite loop
 * for a single ISO does not permanently break rendering.
 */

import { getTimeMapper } from "@/api/world-config";
import { logger } from "@/lib/logger";
import type { SpaceId, WorldId } from "@/types";
import { TimeMapperError, type FormatResult } from "./format";
import type { InboundMessage, OutboundMessage } from "./worker";

/** Maximum wall-clock time allowed for a single `format` round-trip. */
const WATCHDOG_MS = 50;

type CompileStatus = "uncompiled" | "ready" | "broken";

type RoundTripResult =
  | { ok: true; msg: OutboundMessage }
  | { ok: false; timedOut: true };

interface ClientState {
  /** Current Space, or `null` before {@link init}. */
  spaceId: SpaceId | null;
  /** Current World, or `null` before {@link init}. */
  worldId: WorldId | null;
  /** Lazily-created worker; terminated & recreated on timeout. */
  worker: Worker | null;
  /** Per-ISO memoized results (success and failure). */
  cache: Map<string, FormatResult>;
  /** Has `getTimeMapper` been consulted for this World? */
  loaded: boolean;
  /**
   * Mapper source code, or `null` when none is configured (passthrough).
   * Only meaningful once `loaded` is true.
   */
  mapperCode: string | null;
  /** Compilation state of the CURRENT worker instance. */
  compileStatus: CompileStatus;
  /** Structured error captured when the last compile failed syntactically. */
  syntaxError: TimeMapperError | null;
  /** In-flight load promise (dedupes concurrent callers before first load). */
  loadPromise: Promise<void> | null;
  /** In-flight compile promise (dedupes concurrent callers). */
  compilePromise: Promise<void> | null;
}

const state: ClientState = {
  spaceId: null,
  worldId: null,
  worker: null,
  cache: new Map(),
  loaded: false,
  mapperCode: null,
  compileStatus: "uncompiled",
  syntaxError: null,
  loadPromise: null,
  compilePromise: null,
};

// ─── Worker lifecycle ────────────────────────────────────────────────────────

function createWorker(): Worker {
  const worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  // Defensive: top-level worker errors (not protocol messages) should not be
  // silent. Normal failures arrive as `error` protocol messages, not here.
  worker.onerror = (ev: ErrorEvent) => {
    logger.error("timemapper.worker.error", { message: ev.message });
  };
  return worker;
}

function getWorker(): Worker {
  if (state.worker === null) {
    state.worker = createWorker();
  }
  return state.worker;
}

function destroyWorker(): void {
  if (state.worker !== null) {
    state.worker.terminate();
    state.worker = null;
  }
}

// ─── Serialized request/response ─────────────────────────────────────────────
// The protocol has no correlation id, so at most one round-trip may be in
// flight. `chain` serializes them in arrival order; the cache absorbs
// repeated ISOs so this rarely bottlenecks.

let chain: Promise<unknown> = Promise.resolve();

/**
 * Post one message and await its response, optionally racing a watchdog.
 * `timeoutMs === null` disables the watchdog (used for `compile`, which only
 * runs a dynamic `import()` and cannot loop user code).
 */
function roundTrip(msg: InboundMessage, timeoutMs: number | null): Promise<RoundTripResult> {
  return new Promise((resolve) => {
    const worker = getWorker();
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onMessage = (ev: MessageEvent<OutboundMessage>): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      worker.removeEventListener("message", onMessage);
      resolve({ ok: true, msg: ev.data });
    };

    if (timeoutMs !== null) {
      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        resolve({ ok: false, timedOut: true });
      }, timeoutMs);
    }

    worker.addEventListener("message", onMessage);
    worker.postMessage(msg);
  });
}

function sendAndWait(msg: InboundMessage, timeoutMs: number | null): Promise<RoundTripResult> {
  // Queue behind any in-flight round-trip; advance the chain regardless of
  // outcome so a rejection (theoretically impossible here) never stalls it.
  const result = chain.then(() => roundTrip(msg, timeoutMs));
  chain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

// ─── Lazy load + compile ─────────────────────────────────────────────────────

function ensureLoaded(): Promise<void> {
  if (state.loaded) return Promise.resolve();
  if (state.loadPromise) return state.loadPromise;
  state.loadPromise = (async () => {
    if (state.spaceId === null || state.worldId === null) {
      // Not bound to a World yet — degrade to passthrough.
      state.mapperCode = null;
      state.loaded = true;
      return;
    }
    const { spaceId, worldId } = state;
    try {
      const config = await getTimeMapper(spaceId, worldId);
      state.mapperCode = config === null ? null : config.code;
    } catch (e) {
      // IPC failure (e.g. World vanished) — degrade to passthrough rather
      // than blocking every timestamp render.
      logger.warn("timemapper.load.failed", { error: String(e) });
      state.mapperCode = null;
    }
    state.loaded = true;
  })();
  return state.loadPromise;
}

function ensureCompiled(): Promise<void> {
  if (state.compileStatus === "ready" || state.compileStatus === "broken") {
    return Promise.resolve();
  }
  if (state.compilePromise) return state.compilePromise;
  state.compilePromise = (async () => {
    const code = state.mapperCode;
    if (code === null) return; // nothing to compile — caller guards this
    const res = await sendAndWait({ type: "compile", code }, null);
    if (!res.ok) {
      // compile uses no watchdog; this branch is unreachable. Degrade safely.
      state.syntaxError = new TimeMapperError("syntax", "compile timed out");
      state.compileStatus = "broken";
      return;
    }
    const msg = res.msg;
    if (msg.type === "compiled") {
      state.compileStatus = "ready";
      state.syntaxError = null;
      return;
    }
    if (msg.type === "result") return; // impossible for a compile request
    // msg.type === "error"
    state.syntaxError = new TimeMapperError("syntax", msg.message);
    state.compileStatus = "broken";
    logger.warn("timemapper.compile.syntax_error", { error: msg.message });
  })();
  return state.compilePromise;
}

// ─── Public singleton surface ────────────────────────────────────────────────

function resetState(): void {
  state.loaded = false;
  state.loadPromise = null;
  state.mapperCode = null;
  state.compileStatus = "uncompiled";
  state.compilePromise = null;
  state.syntaxError = null;
  state.cache.clear();
  destroyWorker();
}

function init(spaceId: SpaceId, worldId: WorldId): void {
  resetState();
  state.spaceId = spaceId;
  state.worldId = worldId;
}

function reloadMapper(): void {
  resetState();
}

async function format(iso: string): Promise<FormatResult> {
  const cached = state.cache.get(iso);
  if (cached) return cached;

  await ensureLoaded();

  // No mapper configured → render raw ISO. The "none" fact is cached in
  // `state` (loaded + mapperCode === null), so this never hits the worker.
  if (state.mapperCode === null) {
    return { ok: true, display: iso };
  }

  await ensureCompiled();

  // Broken mapper (syntax) → fall back, caching the structured error per ISO.
  if (state.compileStatus === "broken" && state.syntaxError) {
    const result: FormatResult = { ok: false, display: iso, error: state.syntaxError };
    state.cache.set(iso, result);
    return result;
  }

  const res = await sendAndWait({ type: "format", iso }, WATCHDOG_MS);
  if (!res.ok) {
    // Watchdog fired — terminate the (possibly looping) worker and mark the
    // fresh one as needing recompilation, but keep failing for THIS iso cached.
    logger.warn("timemapper.format.timeout", { timeout_ms: WATCHDOG_MS });
    destroyWorker();
    state.compileStatus = "uncompiled";
    state.compilePromise = null;
    const error = new TimeMapperError("timeout", "Timed out after 50ms");
    const result: FormatResult = { ok: false, display: iso, error };
    state.cache.set(iso, result);
    return result;
  }

  const msg = res.msg;
  if (msg.type === "result") {
    const result: FormatResult = { ok: true, display: msg.display };
    state.cache.set(iso, result);
    return result;
  }

  if (msg.type === "compiled") {
    // A `compiled` reply to a `format` request is a protocol violation.
    // Fall back to raw ISO rather than crashing.
    return { ok: true, display: iso };
  }

  // msg.type === "error", kind === "runtime"
  logger.warn("timemapper.format.runtime_error", { error: msg.message });
  const error = new TimeMapperError("runtime", msg.message);
  const result: FormatResult = { ok: false, display: iso, error };
  state.cache.set(iso, result);
  return result;
}

export const timeMapperClient = {
  init,
  reloadMapper,
  format,
};
