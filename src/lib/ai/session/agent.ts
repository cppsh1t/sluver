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
} from "@/lib/ai/loop";
import { composeSystemPrompt } from "@/lib/ai/pipeline";

import type { Plan } from "./plan";
import {
  toModelMessage,
  toSessionMessage,
  type SessionMessage,
  type SessionStore,
} from "./store";

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
    const modelMessages = [...this.messages, userMessage].map(toModelMessage);
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
    void handle.result
      .then((result) => {
        const delta = result.messages.slice(inputLength);
        if (delta.length === 0) return;
        const sessionDelta = delta.map((m) =>
          toSessionMessage(m, this.sessionId),
        );
        this.messages.push(...sessionDelta);
        this.#persist(sessionDelta);
      })
      .catch((e) => this.onPersistError?.(e));

    return handle;
  }

  /**
   * Fire-and-forget persist with error routing to {@link onPersistError}.
   * Never throws — failures are surfaced via the callback if provided.
   */
  #persist(delta: SessionMessage[]): void {
    void this.store.appendMessages(this.sessionId, delta).catch((e) => {
      this.onPersistError?.(e);
    });
  }
}
