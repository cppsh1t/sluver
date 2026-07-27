/**
 * Agent runtime — a manual, single-step-at-a-time tool-calling loop over the
 * Vercel AI SDK v7 {@link streamText}.
 *
 * ## Why a manual loop?
 *
 * The SDK ships higher-level agents (`ToolLoopAgent`), but they couple to UI
 * message types and carry concerns (approval, telemetry, prepare-step) this
 * runtime deliberately does not own. Instead we drive `streamText` with
 * `stopWhen: isStepCount(1)` — one model call per iteration — so the loop owns
 * termination, event emission, and message accumulation directly. This keeps
 * the surface tiny, framework-free, and fully observable. (Design rationale is
 * captured in ADR-0017.)
 *
 * ## Lifecycle
 *
 * An {@link Agent} is constructed once from an {@link AgentOptions} bag and may
 * be **sequentially** reused (`await run(); run();`). It CANNOT run
 * concurrently: a second `.run()` while one is active throws `ConfigError`.
 * Each `.run()` returns an {@link AgentRunHandle} that owns its own subscriber
 * set; the loop begins on the *next* microtask so a caller that subscribes
 * synchronously is guaranteed to see `run_start`.
 *
 * ## Abort resolves (does not reject)
 *
 * Aborting a run — via the input `abortSignal` or `handle.abort()` — resolves
 * `handle.result` with `{ finishReason: 'aborted', ... }`. Only a
 * stream-terminating *error* rejects the promise. See ADR-0018.
 *
 * ## Purity
 *
 * This module imports only from `"ai"` and its siblings — never React, the
 * project logger, or the IPC layer (ADR-0019). Observability is the consumer's
 * job (`agent-logging.ts`).
 */

import {
  isStepCount,
  streamText,
  type FinishReason,
  type LanguageModelUsage,
  type ModelMessage,
  type StepResult,
  type ToolSet,
} from "ai";

import {
  AgentError,
  ConfigError,
  ToolError,
  classifyFromSdkError,
  extractMessage,
} from "./errors";
import { AgentEmitter, type AgentEvent } from "./events";
import type {
  AgentFinishReason,
  AgentOptions,
  AgentRunInput,
  AgentRunResult,
} from "./types";

// ─── Public handle ───────────────────────────────────────────────────────

/**
 * Per-run handle returned by {@link Agent.run}. Owns its own subscriber set and
 * the run's result promise. `runId` is an ephemeral UUID v4 (not persisted).
 */
export interface AgentRunHandle {
  /** Ephemeral UUID v4 identifying this run. */
  readonly runId: string;
  /** Register a per-run event listener; returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void;
  /**
   * Abort the run. Idempotent (no-op if already settled). The internal signal
   * propagates to the active `streamText` call and to tool execution.
   * `handle.result` resolves with `finishReason: 'aborted'`.
   */
  abort(reason?: string): void;
  /**
   * Resolves with the final {@link AgentRunResult} (including for abort).
   * Rejects **only** when `finishReason === 'error'`.
   */
  readonly result: Promise<AgentRunResult>;
}

// ─── Agent ───────────────────────────────────────────────────────────────

/**
 * A single-run tool-calling executor. Construct once, reuse sequentially.
 *
 * Stateful across the lifetime of a run (the `#running` guard, the internal
 * abort controller) but **stateless across runs** — no conversation memory.
 * Multi-turn dialogue is a future wrapper layer's responsibility, not ours.
 */
export class Agent {
  readonly #options: AgentOptions;
  #running = false;

  /**
   * @throws {ConfigError} if `maxSteps` is less than 1.
   */
  constructor(options: AgentOptions) {
    if (
      !Number.isInteger(options.maxSteps) ||
      options.maxSteps < 1
    ) {
      throw new ConfigError(
        `AgentOptions.maxSteps must be a positive integer (got ${options.maxSteps}).`,
      );
    }
    this.#options = options;
  }

  /**
   * Start a run. Returns synchronously with a handle; the loop begins on the
   * next microtask so the caller can subscribe before `run_start` fires.
   *
   * @throws {ConfigError} if a run is already active on this instance.
   */
  run(input: AgentRunInput): AgentRunHandle {
    if (this.#running) {
      throw new ConfigError(
        "Agent already running — await the prior run's result before calling run() again.",
      );
    }
    this.#running = true;

    const runId = crypto.randomUUID();
    const internalController = new AbortController();
    const cleanupExternalAbort = this.#wireExternalAbort(
      input.abortSignal,
      internalController,
    );

    const emitter = new AgentEmitter();

    // The result promise is resolved/rejected by the loop. The loop runs on the
    // next microtask (queueMicrotask) so `handle.subscribe()` below can attach
    // before `run_start` is emitted.
    const result: Promise<AgentRunResult> = new Promise<AgentRunResult>(
      (resolve, reject) => {
        queueMicrotask(() => {
          this.#runLoop(
            input,
            runId,
            internalController,
            emitter,
            cleanupExternalAbort,
          ).then(resolve, reject);
        });
      },
    );

    return {
      runId,
      subscribe: (listener) => emitter.subscribe(listener),
      abort: (reason) => {
        if (!internalController.signal.aborted) {
          internalController.abort(reason);
        }
      },
      result,
    };
  }

  /**
   * Forward an external abort signal (if any) to the internal controller.
   * Returns a cleanup function that removes the listener; the caller MUST
   * invoke it when the run ends to avoid leaking a closure on a long-lived
   * external signal.
   */
  #wireExternalAbort(
    external: AbortSignal | undefined,
    internal: AbortController,
  ): (() => void) | undefined {
    if (!external) return undefined;
    if (external.aborted) {
      internal.abort(external.reason);
      return undefined;
    }
    const onAbort = (): void => internal.abort(external.reason);
    external.addEventListener("abort", onAbort, { once: true });
    return () => external.removeEventListener("abort", onAbort);
  }

  /**
   * The step loop. Returns the final result on success / abort / max-steps;
   * throws an {@link AgentError} only when `finishReason === 'error'`.
   */
  async #runLoop(
    input: AgentRunInput,
    runId: string,
    internalController: AbortController,
    emitter: AgentEmitter,
    cleanupExternalAbort: (() => void) | undefined,
  ): Promise<AgentRunResult> {
    // Defensive copy — the caller's array (and its elements) are never mutated.
    const messages: ModelMessage[] = [...input.messages];
    const steps: StepResult<ToolSet>[] = [];
    let stepCount = 0;
    let finishReason: AgentFinishReason = "stop";
    let runError: AgentError | undefined;
    const signal = internalController.signal;

    emitter.emit({
      type: "run_start",
      runId,
      inputMessageCount: input.messages.length,
    });

    try {
      while (true) {
        // ── Termination ladder, rung 1: pre-step abort ──
        if (signal.aborted) {
          finishReason = "aborted";
          emitter.emit({ type: "abort", runId, reason: abortReason(signal) });
          break;
        }

        emitter.emit({ type: "step_start", runId, stepNumber: stepCount });
        const stepStartMark = performance.now();

        const outcome = await this.#executeStep(
          messages,
          stepCount,
          runId,
          signal,
          emitter,
        );

        if (outcome.kind === "aborted") {
          finishReason = "aborted";
          emitter.emit({ type: "abort", runId, reason: abortReason(signal) });
          break;
        }

        if (outcome.kind === "errored") {
          finishReason = "error";
          runError = outcome.error;
          emitter.emit({
            type: "error",
            runId,
            stepNumber: stepCount,
            error: outcome.error,
          });
          break;
        }

        // ── Success: record the step ──
        const latencyMs = performance.now() - stepStartMark;
        emitter.emit({
          type: "step_end",
          runId,
          stepNumber: stepCount,
          finishReason: outcome.finalStep.finishReason,
          usage: outcome.usage,
          latencyMs,
        });

        messages.push(...outcome.responseMessages);
        steps.push(outcome.finalStep);

        // ── Termination ladder, rung 3: non-tool-call finish ──
        if (outcome.finalStep.finishReason !== "tool-calls") {
          finishReason = mapStepFinishReason(outcome.finalStep.finishReason);
          break;
        }

        // ── Termination ladder, rung 4: step budget ──
        stepCount++;
        if (stepCount >= this.#options.maxSteps) {
          finishReason = "max-steps";
          break;
        }
        // else continue to the next step
      }
    } catch (value) {
      // Defensive belt-and-suspenders: `#executeStep` classifies every escape
      // internally and `AgentEmitter.emit` swallows subscriber errors, so the
      // loop body cannot throw under normal operation. This catch exists to
      // normalise any unforeseen escape so the caller never sees a raw throw.
      runError =
        value instanceof AgentError ? value : classifyFromSdkError(value);
      finishReason = "error";
    } finally {
      this.#running = false;
      // Remove the external-abort listener so we don't leak a closure on a
      // long-lived caller signal. No-op if the listener already fired
      // ({ once: true }) or was never attached.
      cleanupExternalAbort?.();
    }

    return this.#buildResult(
      messages,
      steps,
      runId,
      finishReason,
      runError,
      emitter,
    );
  }

  /**
   * Run a single `streamText` call (one model turn), drain its stream into
   * events, and return a discriminated outcome. Never throws — stream-terminating
   * errors become `{ kind: 'errored' }`.
   */
  async #executeStep(
    messages: ModelMessage[],
    stepNumber: number,
    runId: string,
    signal: AbortSignal,
    emitter: AgentEmitter,
  ): Promise<StepOutcome> {
    let stepError: AgentError | undefined;
    let abortedDuringStream = false;

    try {
      const result = streamText({
        model: this.#options.model,
        system: this.#options.systemPrompt,
        messages,
        tools: this.#options.tools,
        stopWhen: isStepCount(1),
        temperature: this.#options.temperature,
        topP: this.#options.topP,
        maxOutputTokens: this.#options.maxOutputTokens,
        maxRetries: this.#options.maxRetries,
        timeout: this.#options.timeout,
        providerOptions: this.#options.providerOptions,
        abortSignal: signal,
      });

      for await (const part of result.stream) {
        switch (part.type) {
          case "text-delta":
            emitter.emit({
              type: "text_delta",
              runId,
              stepNumber,
              delta: part.text,
            });
            break;
          case "reasoning-delta":
            emitter.emit({
              type: "reasoning_delta",
              runId,
              stepNumber,
              delta: part.text,
            });
            break;
          case "tool-input-delta":
            emitter.emit({
              type: "tool_input_delta",
              runId,
              stepNumber,
              delta: part.delta,
            });
            break;
          case "tool-call":
            emitter.emit({
              type: "tool_call",
              runId,
              stepNumber,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
            });
            break;
          case "tool-result":
            emitter.emit({
              type: "tool_result",
              runId,
              stepNumber,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              output: part.output,
            });
            break;
          case "tool-error":
            // Decision 7: pure passthrough — emit and continue. Tool errors are
            // non-fatal; the SDK feeds them back to the model on the next step.
            emitter.emit({
              type: "tool_error",
              runId,
              stepNumber,
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              error: new ToolError(extractMessage(part.error), part.error),
            });
            break;
          case "error":
            stepError = classifyFromSdkError(part.error);
            break;
          case "abort":
            abortedDuringStream = true;
            break;
          default:
            // start / start-step / finish-step / finish / raw / source / file /
            // *-start / *-end / custom / approval — not surfaced as events.
            break;
        }
      }

      // Stream drained. Decide before awaiting the PromiseLike results.
      if (abortedDuringStream || signal.aborted) {
        return { kind: "aborted" };
      }
      if (stepError) {
        return { kind: "errored", error: stepError };
      }

      // Success path: these PromiseLikes resolve immediately once the stream is
      // consumed, but they MUST be awaited (they drain remaining stream state).
      const finalStep = await result.finalStep;
      const responseMessages = await result.responseMessages;
      return {
        kind: "continue",
        finalStep,
        responseMessages,
        usage: finalStep.usage,
      };
    } catch (value) {
      // streamText threw synchronously, the stream threw mid-iteration, or an
      // awaited PromiseLike rejected — classify uniformly.
      return { kind: "errored", error: classifyFromSdkError(value) };
    }
  }

  /**
   * Assemble, freeze, and announce the final result. The `messages` argument is
   * the loop's working array (= `[...inputCopy, ...allResponses]`); we freeze a
   * fresh copy so the returned snapshot cannot be mutated by the caller. Throws
   * on error finish so `handle.result` rejects.
   */
  #buildResult(
    messages: readonly ModelMessage[],
    steps: StepResult<ToolSet>[],
    runId: string,
    finishReason: AgentFinishReason,
    runError: AgentError | undefined,
    emitter: AgentEmitter,
  ): AgentRunResult {
    // Fresh frozen snapshot: `[...input, ...allResponses]` (the working array
    // already holds exactly that). The freeze is shallow — nested message and
    // step objects remain technically mutable — but it catches accidental
    // top-level mutation. Callers should treat the result as logically immutable.
    const frozenMessages: ModelMessage[] = [...messages];
    Object.freeze(frozenMessages);

    const finalText = steps.length > 0 ? steps[steps.length - 1].text : "";

    const totalUsage = steps
      .map((s) => s.usage)
      .reduce(sumUsage, zeroUsage());

    const result: AgentRunResult = {
      runId,
      finishReason,
      messages: frozenMessages,
      finalText,
      totalUsage,
      steps,
    };
    if (runError !== undefined) {
      result.error = runError;
    }
    Object.freeze(result);

    emitter.emit({ type: "run_end", runId, finishReason });

    if (finishReason === "error" && runError !== undefined) {
      throw runError;
    }
    return result;
  }
}

// ─── Per-step outcome (internal) ─────────────────────────────────────────

type StepOutcome =
  | { kind: "continue"; finalStep: StepResult<ToolSet>; responseMessages: ModelMessage[]; usage: LanguageModelUsage }
  | { kind: "aborted" }
  | { kind: "errored"; error: AgentError };

// ─── Helpers ─────────────────────────────────────────────────────────────

/** Map an SDK per-step `FinishReason` onto the runtime's `AgentFinishReason`. */
function mapStepFinishReason(reason: FinishReason): AgentFinishReason {
  switch (reason) {
    case "stop":
    case "length":
    case "content-filter":
    case "other":
    case "error":
      return reason;
    default:
      // 'tool-calls' never reaches here (handled by the ladder), and any future
      // SDK value maps defensively to 'other'.
      return "other";
  }
}

/** An `AbortSignal.reason` coerced to a string reason, if it is one. */
function abortReason(signal: AbortSignal): string | undefined {
  const reason = signal.reason;
  return typeof reason === "string" ? reason : undefined;
}

/** A zeroed-out usage object (used when no steps completed). */
function zeroUsage(): LanguageModelUsage {
  return {
    inputTokens: undefined,
    inputTokenDetails: {
      noCacheTokens: undefined,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: undefined,
    outputTokenDetails: {
      textTokens: undefined,
      reasoningTokens: undefined,
    },
    totalTokens: undefined,
  };
}

/** Sum two usage objects field-by-field (`undefined` treated as absent). */
function sumUsage(
  a: LanguageModelUsage,
  b: LanguageModelUsage,
): LanguageModelUsage {
  return {
    inputTokens: addTokens(a.inputTokens, b.inputTokens),
    inputTokenDetails: {
      noCacheTokens: addTokens(
        a.inputTokenDetails.noCacheTokens,
        b.inputTokenDetails.noCacheTokens,
      ),
      cacheReadTokens: addTokens(
        a.inputTokenDetails.cacheReadTokens,
        b.inputTokenDetails.cacheReadTokens,
      ),
      cacheWriteTokens: addTokens(
        a.inputTokenDetails.cacheWriteTokens,
        b.inputTokenDetails.cacheWriteTokens,
      ),
    },
    outputTokens: addTokens(a.outputTokens, b.outputTokens),
    outputTokenDetails: {
      textTokens: addTokens(
        a.outputTokenDetails.textTokens,
        b.outputTokenDetails.textTokens,
      ),
      reasoningTokens: addTokens(
        a.outputTokenDetails.reasoningTokens,
        b.outputTokenDetails.reasoningTokens,
      ),
    },
    totalTokens: addTokens(a.totalTokens, b.totalTokens),
  };
}

function addTokens(
  a: number | undefined,
  b: number | undefined,
): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return (a ?? 0) + (b ?? 0);
}
