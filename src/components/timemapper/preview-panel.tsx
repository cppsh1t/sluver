import { useEffect, useRef, useState } from "react";

import { logger } from "@/lib/logger";
import type { InboundMessage, OutboundMessage } from "@/lib/timemapper/worker";

/** Hardcoded sample timestamps covering past/future/epoch-edge cases. */
const SAMPLES = [
  "2024-03-15T10:30:00Z",
  "1066-10-14T09:00:00Z",
  "2030-06-01T00:00:00Z",
  "1800-01-01T00:00:00Z",
  "2200-12-31T23:59:00Z",
] as const;

/** Per-ISO render outcome (mirrors the client singleton's `FormatResult`). */
interface PreviewRow {
  iso: string;
  status: "ok" | "error" | "timeout";
  display: string;
}

/** Maximum wall-clock time allowed for a single `format` round-trip. */
const WATCHDOG_MS = 50;
/** Debounce window before recompiling after the user stops typing. */
const DEBOUNCE_MS = 300;

/** Initial placeholder rows so the table renders before the first compile. */
function initialRows(): PreviewRow[] {
  return SAMPLES.map((iso) => ({ iso, status: "ok", display: iso }));
}

interface PreviewPanelProps {
  /** CURRENT (possibly unsaved) editor content — NOT the persisted value. */
  code: string;
}

/**
 * Live preview for the TimeMapper editor (ADR-0026).
 *
 * Runs its OWN dedicated Web Worker (separate from the singleton client used
 * for live timestamp rendering) so the preview reflects unsaved edits. The
 * worker protocol carries no correlation id, so all round-trips are serialized
 * via a promise chain; each `format` races a 50ms watchdog — on timeout the
 * looping worker is terminated and recreated (recompiled) so one bad sample
 * can't permanently wedge the preview.
 */
export function PreviewPanel({ code }: PreviewPanelProps) {
  const [compileError, setCompileError] = useState<string | null>(null);
  const [rows, setRows] = useState<PreviewRow[]>(initialRows);
  const [isWorking, setWorking] = useState(false);

  // Worker owned by this panel (NOT the global one). Created once, terminated
  // on unmount; recreated on watchdog timeout.
  const workerRef = useRef<Worker | null>(null);
  // Serialized round-trip chain — only one message may be in flight at a time
  // (the protocol has no correlation id).
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());

  useEffect(() => {
    const worker = new Worker(
      new URL("../../lib/timemapper/worker.ts", import.meta.url),
      { type: "module" },
    );
    worker.onerror = (ev: ErrorEvent) => {
      logger.warn("timemapper.preview.worker_error", { message: ev.message });
    };
    workerRef.current = worker;

    return () => {
      worker.terminate();
      workerRef.current = null;
      // Drop any pending serialized work so a late resolve can't touch state.
      chainRef.current = Promise.resolve();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setWorking(true);

    const handle = setTimeout(() => {
      void runPreview();
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };

    /** Recreate the worker after a timeout (or worker death). */
    function recreateWorker(): Worker {
      workerRef.current?.terminate();
      const next = new Worker(
        new URL("../../lib/timemapper/worker.ts", import.meta.url),
        { type: "module" },
      );
      next.onerror = (ev: ErrorEvent) => {
        logger.warn("timemapper.preview.worker_error", { message: ev.message });
      };
      workerRef.current = next;
      return next;
    }

    /**
     * Post one message and await its single next response, racing a watchdog.
     * `timeoutMs === null` disables the watchdog (used for `compile`).
     * Returns `"timeout"` on watchdog fire, else the outbound message.
     * Serialized via `chainRef` so only one round-trip is ever in flight.
     */
    function send(
      msg: InboundMessage,
      timeoutMs: number | null,
    ): Promise<OutboundMessage | "timeout"> {
      const run = (): Promise<OutboundMessage | "timeout"> =>
        new Promise((resolve) => {
          const worker = workerRef.current;
          if (worker === null) {
            resolve("timeout");
            return;
          }
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | null = null;

          const onMessage = (ev: MessageEvent<OutboundMessage>): void => {
            if (settled) return;
            settled = true;
            if (timer !== null) clearTimeout(timer);
            worker.removeEventListener("message", onMessage);
            resolve(ev.data);
          };

          if (timeoutMs !== null) {
            timer = setTimeout(() => {
              if (settled) return;
              settled = true;
              worker.removeEventListener("message", onMessage);
              resolve("timeout");
            }, timeoutMs);
          }

          worker.addEventListener("message", onMessage);
          worker.postMessage(msg);
        });

      const result = chainRef.current.then(run);
      chainRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    }

    async function runPreview(): Promise<void> {
      if (cancelled) return;

      // Recompile the (possibly unsaved) source.
      const compileRes = await send({ type: "compile", code }, null);
      if (cancelled) return;

      if (compileRes === "timeout") {
        // Unreachable — compile uses no watchdog — but degrade safely.
        setCompileError("compile timed out");
        setRows(initialRows());
        setWorking(false);
        return;
      }

      if (compileRes.type === "error" && compileRes.kind === "syntax") {
        setCompileError(compileRes.message);
        setRows(initialRows());
        setWorking(false);
        return;
      }

      // compileRes.type === "compiled"
      setCompileError(null);

      const nextRows: PreviewRow[] = [];
      for (const iso of SAMPLES) {
        if (cancelled) return;
        const res = await send({ type: "format", iso }, WATCHDOG_MS);
        if (cancelled) return;

        if (res === "timeout") {
          // The worker is likely stuck in a user-code infinite loop.
          // Terminate + recreate + recompile so subsequent samples still work.
          recreateWorker();
          const recompile = await send({ type: "compile", code }, null);
          if (cancelled) return;
          // If recompile itself failed, mark the rest as errored and bail.
          if (
            recompile !== "timeout" &&
            recompile.type === "error" &&
            recompile.kind === "syntax"
          ) {
            setCompileError(recompile.message);
            setRows(initialRows());
            setWorking(false);
            return;
          }
          nextRows.push({ iso, status: "timeout", display: "⏱ timeout" });
          continue;
        }

        if (res.type === "result") {
          nextRows.push({ iso, status: "ok", display: res.display });
          continue;
        }

        if (res.type === "error" && res.kind === "runtime") {
          nextRows.push({ iso, status: "error", display: res.message });
          continue;
        }

        // A `compiled` reply to a `format` request is a protocol violation;
        // fall back to raw ISO.
        nextRows.push({ iso, status: "ok", display: iso });
      }

      if (!cancelled) {
        setRows(nextRows);
        setWorking(false);
      }
    }
  }, [code]);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-heading text-sm font-medium tracking-tight">
          预览
        </h3>
        {isWorking && (
          <span className="text-xs text-muted-foreground">渲染中…</span>
        )}
      </div>

      {compileError !== null && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
          <p className="text-xs font-medium text-destructive">语法错误</p>
          <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-xs text-destructive/90">
            {compileError}
          </pre>
        </div>
      )}

      <div className="overflow-hidden rounded-md border border-border">
        <table className="w-full text-xs">
          <thead className="bg-muted/50 text-muted-foreground">
            <tr>
              <th className="px-3 py-2 text-left font-medium">输入 (ISO)</th>
              <th className="px-3 py-2 text-left font-medium">输出</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map((row) => (
              <tr key={row.iso} className="align-top">
                <td className="px-3 py-2 font-mono text-muted-foreground">
                  {row.iso}
                </td>
                <td
                  className={
                    row.status === "ok"
                      ? "px-3 py-2 break-all"
                      : "px-3 py-2 break-all text-destructive"
                  }
                >
                  {row.display}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
