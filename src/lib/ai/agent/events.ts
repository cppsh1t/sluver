/**
 * Lifecycle event surface for the Agent runtime library.
 *
 * An {@link AgentEvent} is a discriminated union describing everything the loop
 * emits during a run: stream deltas (text / reasoning / tool-input), discrete
 * tool outcomes, step boundaries, and run boundaries. Delta events carry only
 * the incremental chunk; discrete events carry full payloads.
 *
 * ## Sync contract
 *
 * Emission and subscription are **synchronous**. Subscribers are invoked in
 * insertion order, and the loop starts on the *next* microtask after
 * `agent.run()` returns, so a caller that subscribes synchronously after
 * `run()` is guaranteed to see the `run_start` event.
 *
 * ## Subscriber error handling
 *
 * A subscriber that throws is caught per-listener and **swallowed silently**.
 * This is intentional: the library is pure (ADR-0019) and cannot import the
 * project logger, and one buggy subscriber must not crash the run. Consumer-side
 * observability is the application's job — see `agent-logging.ts`.
 */

import type { FinishReason, LanguageModelUsage } from "ai";

import type { AgentError } from "./errors";
import type { AgentFinishReason } from "./types";

// ─── Events ──────────────────────────────────────────────────────────────

/**
 * Discriminated union of every event emitted during an agent run. The `type`
 * field is the discriminant; `runId` identifies the run; `stepNumber` (zero-based)
 * is present on per-step events and the terminal `error` event, and absent from
 * `run_start` / `run_end` / `abort`.
 *
 * ## Step-termination pairing
 *
 * Every step emits `step_start`. The matching terminator is **one of**:
 * - `step_end` — the step completed normally (success or model-natural-stop);
 * - `abort`   — the step was aborted (supersedes `step_end`);
 * - `error`   — the step failed with a stream-terminating error (supersedes
 *               `step_end`).
 *
 * Consumers pairing start↔end must treat `abort` and `error` as alternative
 * step terminators, not additional events.
 */
export type AgentEvent =
  // ── Run boundaries ──
  | { type: "run_start"; runId: string; inputMessageCount: number }
  | { type: "run_end"; runId: string; finishReason: AgentFinishReason }
  // ── Step boundaries ──
  | { type: "step_start"; runId: string; stepNumber: number }
  | {
      type: "step_end";
      runId: string;
      stepNumber: number;
      finishReason: FinishReason;
      usage: LanguageModelUsage;
      latencyMs: number;
    }
  // ── Streaming deltas ──
  | { type: "text_delta"; runId: string; stepNumber: number; delta: string }
  | { type: "reasoning_delta"; runId: string; stepNumber: number; delta: string }
  | { type: "tool_input_delta"; runId: string; stepNumber: number; delta: string }
  // ── Tool outcomes (discrete) ──
  | {
      type: "tool_call";
      runId: string;
      stepNumber: number;
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      runId: string;
      stepNumber: number;
      toolCallId: string;
      toolName: string;
      output: unknown;
    }
  | {
      type: "tool_error";
      runId: string;
      stepNumber: number;
      toolCallId: string;
      toolName: string;
      error: AgentError;
    }
  // ── Terminal ──
  | { type: "error"; runId: string; stepNumber: number; error: AgentError }
  | { type: "abort"; runId: string; reason?: string };

/** A listener invoked synchronously by {@link AgentEmitter.emit}. */
export type AgentEventListener = (event: AgentEvent) => void;

// ─── Emitter ─────────────────────────────────────────────────────────────

/**
 * Minimal synchronous fan-out for {@link AgentEvent}s.
 *
 * One instance per run (the run owns its subscriber set). Subscribers fire in
 * insertion order; a throwing subscriber is isolated so it cannot break
 * delivery to the rest.
 */
export class AgentEmitter {
  #listeners: AgentEventListener[] = [];

  /**
   * Register a listener. Returns an unsubscribe function.
   * Idempotent unsubscribe (calling the returned fn more than once is a no-op).
   */
  subscribe(listener: AgentEventListener): () => void {
    this.#listeners.push(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#listeners = this.#listeners.filter((l) => l !== listener);
    };
  }

  /**
   * Deliver an event to every subscriber synchronously, in insertion order.
   * The listener array is snapshotted before iteration so that subscribers
   * which (un)subscribe during emit cannot shift indices and skip/double-fire
   * siblings. Per Decision 4 / 12, listener exceptions are swallowed — see
   * module docstring.
   */
  emit(event: AgentEvent): void {
    const snapshot = [...this.#listeners];
    for (const listener of snapshot) {
      try {
        listener(event);
      } catch {
        // Intentionally swallowed. The library is pure (ADR-0019) and cannot
        // log; a buggy consumer subscriber must not abort the run. Wire
        // `createAgentEventLogger` (outside the purity boundary) to observe
        // runs — it will not see subscriber-internal failures by design.
      }
    }
  }
}
