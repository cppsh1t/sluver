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
 * Imports only from `@/lib/ai/loop` (the pure runtime), this module's
 * `./store`, and the `ai` SDK — never React, the project logger, or the IPC
 * layer (ADR-0019). The `SessionStore` is an injected interface; the library
 * does not know how it is implemented.
 *
 * Related: ADR-0020 (session layer), ADR-0017 (AgentLoop manual step loop),
 * ADR-0018 (all terminations resolve).
 */

import {
  AgentLoop,
  type AgentRunHandle,
} from "@/lib/ai/loop";

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
  private readonly onPersistError?: (error: unknown) => void;
  private messages: SessionMessage[] = [];

  private constructor(options: AgentOptions) {
    this.loop = options.loop;
    this.store = options.store;
    this.sessionId = options.sessionId;
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

    // 3. Drive the loop — throws ConfigError if busy. No side effects
    //    committed yet, so a throw here is clean.
    const handle = this.loop.run({
      messages: modelMessages,
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
