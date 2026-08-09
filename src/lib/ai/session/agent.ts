/**
 * Stateful Agent — the consumer-facing conversational wrapper around
 * {@link AgentLoop}.
 *
 * Owns conversation memory (an accumulated message thread), drives the loop
 * one turn at a time, and auto-persists message deltas via an injected
 * {@link SessionStore}. One `Agent` instance is bound to one session for its
 * lifetime — switching conversations means constructing a new `Agent`.
 *
 * ## Lifecycle
 *
 * Constructed via the async factory {@link Agent.open}, which loads history
 * from the store. Each `agent.run(text)` appends a user message (persisted
 * best-effort), drives the loop, and on resolution appends the response delta. Because `AgentLoop` never rejects (ADR-0018, revised),
 * the same `.then()` path handles success, abort, and error uniformly.
 *
 * ## Purity
 *
 * Imports only from `@/lib/ai/loop` (the pure runtime), `@/lib/ai/pipeline`
 * (the pure Derived-Model-Input transforms — ADR-0028), this module's
 * `./store` and `./plan`, and the `ai` SDK — never React, the project logger,
 * or the IPC layer (ADR-0019). The `SessionStore` is an injected interface;
 * the library does not know how it is implemented.
 *
 * Related: ADR-0020 (session layer), ADR-0017 (AgentLoop manual step loop),
 * ADR-0018 (all terminations resolve), ADR-0028 (three-layer message model).
 */

import {
  AgentLoop,
  type AgentRunHandle,
  type LanguageModelUsage,
} from "@/lib/ai/loop";
import {
  compactToolCalls,
  composeSystemPrompt,
  type CompactionPolicy,
} from "@/lib/ai/pipeline";
import type {
  ToolCallPart,
  ToolResultPart,
} from "ai";

import type { Plan } from "./plan";
import {
  toModelMessage,
  toSessionMessage,
  type SessionMessage,
  type SessionStore,
} from "./store";

// ─── Defaults ────────────────────────────────────────────────────────────

/**
 * The default {@link CompactionPolicy} used when a caller does not pass one
 * (e.g. legacy consumers, tests). Matches ADR-0031 §1's recommended defaults
 * — compaction OFF, threshold N = 3. The threshold is moot while `enabled`
 * is `false` (the compactor short-circuits), but a sane value keeps the field
 * non-zero for downstream consumers that read it for display.
 */
const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  enabled: false,
  turnAge: 3,
};

// ─── Options ─────────────────────────────────────────────────────────────

/**
 * Construction options for a stateful {@link Agent}.
 *
 * The caller constructs an {@link AgentLoop} separately (with its
 * `LanguageModel`, system prompt, tools, etc.) and passes it in — the Agent
 * does not know or care how the loop was built.
 */
export interface AgentOptions {
  /** The stateless loop executor to drive each turn. */
  readonly loop: AgentLoop;
  /** Persistence interface (concrete impl lives outside the library). */
  readonly store: SessionStore;
  /** The session identity this Agent is bound to. Must pre-exist in the store. */
  readonly sessionId: string;
  /**
   * The role's static system prompt (e.g. `EXPLORER_SYSTEM_PROMPT`). The Agent
   * composes this with the live Plan snapshot on every `run()` to produce the
   * per-run system prompt (ADR-0028 pipeline — Plan reminder injection). This
   * is the SAME value passed to the `AgentLoop` constructor's `systemPrompt`;
   * Agent keeps its own copy so it can override per-run.
   */
  readonly roleStaticPrompt: string;
  /**
   * Called when a background persistence operation fails (user message or
   * response delta). The library never throws on persist errors — the app
   * layer decides how to surface this (log, toast, retry). If omitted, persist
   * errors are silently swallowed.
   */
  readonly onPersistError?: (error: unknown) => void;
  /**
   * Per-role tool-call compaction policy (ADR-0031 Phase 1). When `enabled`,
   * aged tool-call + tool-result pairs in the Derived Model Input are replaced
   * with short text stubs at {@link Agent.run} entry. The original (uncompacted)
   * pairs remain available via {@link Agent.findToolPair} for the
   * `context_read` tool to expand on demand.
   *
   * Defaults to `{ enabled: false, turnAge: 3 }` (ADR-0031 §1) — compaction is
   * opt-in per role. The policy is captured at Agent construction time; a
   * config change takes effect the next time the Space window reopens and the
   * Provider rebuilds the Agent (same lifecycle as model rebinding, ADR-0023).
   */
  readonly compactionPolicy?: CompactionPolicy;
}

// ─── Agent ───────────────────────────────────────────────────────────────

/**
 * A stateful, single-session conversational wrapper around {@link AgentLoop}.
 *
 * Construct once per session via {@link Agent.open}. Call `run(text)` per turn.
 * Never construct directly — use the async factory to ensure history is loaded.
 */
export class Agent {
  private readonly loop: AgentLoop;
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly roleStaticPrompt: string;
  private readonly onPersistError?: (error: unknown) => void;
  private readonly compactionPolicy: CompactionPolicy;
  private messages: SessionMessage[] = [];
  /**
   * The current Plan for this session. Loaded from the store on `open()`;
   * updated in-memory by {@link setPlan}. Snapshotted at `run()` entry for the
   * per-run system-prompt composition (ADR-0028 invariant 2 — the Derived
   * Model Input closes over an immutable snapshot, never live state).
   */
  private plan: Plan | null = null;

  private constructor(options: AgentOptions) {
    this.loop = options.loop;
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.roleStaticPrompt = options.roleStaticPrompt;
    this.onPersistError = options.onPersistError;
    this.compactionPolicy = options.compactionPolicy ?? DEFAULT_COMPACTION_POLICY;
  }

  /**
   * The session identity this Agent is bound to.
   */
  get id(): string {
    return this.sessionId;
  }

  /**
   * Read-only access to the accumulated message thread (persisted + in-flight).
   * Returns a defensive copy — callers cannot mutate the internal array.
   */
  getMessages(): readonly SessionMessage[] {
    return [...this.messages];
  }

  /**
   * The current Plan for this session, or `null` if none is set. Returns the
   * live in-memory value (updated synchronously by {@link setPlan}). Used by
   * the `plan` tool via `PlanAccess.get()` (ADR-0029 Phase 1) to compute
   * output summaries, and snapshotted at {@link run} entry for the per-run
   * system-prompt composition.
   */
  getPlan(): Plan | null {
    return this.plan;
  }

  /**
   * Replace the current Plan. Sets the in-memory value synchronously (so a
   * subsequent {@link getPlan} reflects the new Plan immediately) and
   * fire-and-forget persists it via the store. Persistence errors are routed
   * to {@link onPersistError} — this method never throws.
   *
   * Per ADR-0028 invariant 2, the new Plan takes effect on the NEXT `run()`
   * (which snapshots `this.plan` at entry); the CURRENT run's Derived Model
   * Input is unaffected by a mid-run `setPlan` call.
   */
  setPlan(plan: Plan): Promise<void> {
    this.plan = plan;
    void this.store
      .savePlan(this.sessionId, plan)
      .catch((e) => this.onPersistError?.(e));
    return Promise.resolve();
  }

  /**
   * Find the original (uncompacted) tool-call + tool-result pair for a given
   * `toolCallId` in the Persisted Thread (`this.messages`).
   *
   * Used by the `context_read` tool (ADR-0031 §5) via
   * `ToolContext.threadLookup.findToolPair` to expand a compacted stub back to
   * its full input/output on demand. Per ADR-0028 invariant 1, the Persisted
   * Thread is the source of truth and ALWAYS carries the original, uncompacted
   * content — compaction only reshapes the Derived Model Input (a copy), never
   * the persisted thread.
   *
   * Returns `undefined` when no tool-call with the given id is found, or when
   * the matching tool-result is missing (e.g. an in-flight call that hasn't
   * produced a result yet, or a call whose result was never persisted).
   *
   * @param toolCallId The id printed in a `[tool_call {id}] …` stub.
   */
  findToolPair(toolCallId: string): {
    readonly call: ToolCallPart;
    readonly result: ToolResultPart;
  } | undefined {
    // Two-pass: collect the matching ToolCallPart (from any assistant message)
    // and the matching ToolResultPart (from any tool message), then pair them.
    // A given toolCallId has at most one of each across the whole thread
    // (provider contract — one call, one result). Short-circuits as soon as
    // both are found. Mirrors the pairing pattern of `filterIncompleteToolCalls`
    // in `loop.ts` (the existing tool-call/result handling paradigm).
    let call: ToolCallPart | undefined;
    let result: ToolResultPart | undefined;
    for (const msg of this.messages) {
      // `role` narrows the discriminated union; content is then accessible in
      // its role-specific shape. Skip role messages with string/absent content
      // (they cannot carry tool parts).
      if (msg.role === "assistant") {
        const { content } = msg;
        if (typeof content === "string" || !Array.isArray(content)) continue;
        if (!call) {
          for (const part of content) {
            if (part.type === "tool-call" && part.toolCallId === toolCallId) {
              call = part;
              break;
            }
          }
        }
      } else if (msg.role === "tool") {
        const { content } = msg;
        if (!Array.isArray(content) || content.length === 0) continue;
        if (!result) {
          for (const part of content) {
            if (part.type === "tool-result" && part.toolCallId === toolCallId) {
              result = part;
              break;
            }
          }
        }
      }
      if (call && result) break;
    }
    if (!call || !result) return undefined;
    return { call, result };
  }

  /**
   * Create an Agent bound to `sessionId`, loading conversation history from
   * the store. For a new/empty session, `messages` will be an empty array.
   *
   * @example
   *   const loop = new AgentLoop({ model, systemPrompt, tools, maxSteps });
   *   const agent = await Agent.open({ loop, store, sessionId: "scene-42" });
   *   const handle = agent.run("Write a scene where...");
   *   await handle.result;
   */
  static async open(options: AgentOptions): Promise<Agent> {
    const agent = new Agent(options);
    agent.messages = await options.store.loadMessages(options.sessionId);
    // Load the Plan AFTER messages — both are independent reads, but keeping
    // a stable order makes store implementations easier to reason about. A
    // missing/empty Plan resolves to `null` (store contract), so a fresh
    // session starts with no reminder injection.
    agent.plan = await options.store.loadPlan(options.sessionId);
    return agent;
  }

  /**
   * Send a user message and drive the loop for one turn.
   *
   * Appends the user message to the thread and fires a best-effort persist,
   * then runs the loop with the full message history. On resolution (success,
   * abort, or error — all resolve per ADR-0018 revised), appends the response
   * delta and persists it.
   *
   * The loop's concurrency guard runs BEFORE any side effect is committed —
   * if {@link AgentLoop.run} throws `ConfigError` (already running), the
   * message thread and store are left untouched.
   *
   * Returns the {@link AgentRunHandle} from the underlying loop — subscribe to
   * it for streaming events, await `.result` for the final outcome.
   *
   * @throws {ConfigError} if the loop is already running (inherited from
   *   `AgentLoop` — one turn at a time per Agent).
   */
  run(
    text: string,
    options?: { readonly abortSignal?: AbortSignal },
  ): AgentRunHandle {
    // 0. Snapshot the Plan at function entry. The Derived Model Input MUST be
    //    a pure function of immutable snapshots (ADR-0028 invariant 2) — a
    //    `setPlan` call mid-run does NOT retroactively change this run's
    //    system prompt; it takes effect on the NEXT run.
    const planSnapshot = this.plan;

    // 1. Build the user message WITHOUT mutating state — so a ConfigError
    //    throw from loop.run() (concurrent-run guard) leaves this.messages
    //    and the store untouched.
    const userMessage = toSessionMessage(
      { role: "user", content: text },
      this.sessionId,
    );

    // 2. Build the full thread for the loop (spread — don't mutate).
    //    compactToolCalls (ADR-0031 Phase 1) reshapes the Derived Model Input
    //    by stubbing aged tool-call + tool-result pairs. It is a PURE
    //    transform (ADR-0028 invariant 2) — when the policy is disabled (the
    //    default) it returns the input array verbatim (zero-cost no-op). When
    //    enabled, it allocates a fresh array; the original Persisted Thread
    //    (`this.messages`) is never mutated.
    const rawMessages = [...this.messages, userMessage].map(toModelMessage);
    const modelMessages = compactToolCalls(rawMessages, this.compactionPolicy);
    const inputLength = modelMessages.length;

    // 2b. Compose the per-run system prompt via the pipeline (ADR-0028). The
    //     plan-injector appends the Plan reminder block to the role's static
    //     prompt when a non-empty Plan exists; otherwise the static prompt is
    //     returned verbatim. Pure function — closes over the snapshot only.
    const systemPrompt = composeSystemPrompt({
      staticPrompt: this.roleStaticPrompt,
      plan: planSnapshot,
    });

    // 3. Drive the loop — throws ConfigError if busy. No side effects
    //    committed yet, so a throw here is clean.
    const handle = this.loop.run({
      messages: modelMessages,
      systemPrompt,
      abortSignal: options?.abortSignal,
    });

    // 4. Loop accepted — NOW commit side effects.
    this.messages.push(userMessage);
    this.#persist([userMessage]);

    // 5. On resolution (ALL terminations resolve — ADR-0018 revised),
    //    extract the delta, wrap as SessionMessage, persist.
    //
    //    `result.totalUsage` is forwarded as the optional `turnUsage` so the
    //    store can attach `inputTokens` / `outputTokens` to the delta's last
    //    assistant row (ADR-0030 §1/§2). Aborted runs still resolve with a
    //    partial `totalUsage` (ADR-0018) — we persist it honestly so the
    //    record of "what this interrupted turn cost" survives.
    void handle.result
      .then((result) => {
        const delta = result.messages.slice(inputLength);
        if (delta.length === 0) return;
        const sessionDelta = delta.map((m) =>
          toSessionMessage(m, this.sessionId),
        );
        this.messages.push(...sessionDelta);
        this.#persist(sessionDelta, result.totalUsage);
      })
      .catch((e) => this.onPersistError?.(e));

    return handle;
  }

  /**
    * Fire-and-forget persist with error routing to {@link onPersistError}.
    * Never throws — failures are surfaced via the callback if provided.
    *
    * `turnUsage` is forwarded straight to {@link SessionStore.appendMessages};
    * `undefined` for the user-message persist (which precedes the run), the
    * run's `result.totalUsage` for the response delta. See ADR-0030.
    */
  #persist(
    delta: SessionMessage[],
    turnUsage?: LanguageModelUsage,
  ): void {
    void this.store
      .appendMessages(this.sessionId, delta, turnUsage)
      .catch((e) => {
        this.onPersistError?.(e);
      });
  }
}
