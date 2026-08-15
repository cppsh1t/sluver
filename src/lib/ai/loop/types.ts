/**
 * Type surface for the AgentLoop runtime library.
 *
 * This is a **framework-agnostic** AI agent execution layer built on the
 * Vercel AI SDK v7. It has zero React / app dependencies — it is a pure
 * transform over {@link ModelMessage} threads, driving the SDK's
 * {@link streamText} one step at a time and exposing a typed result + event
 * stream. See the sibling `loop.ts` for the runtime; this module holds the
 * contracts only.
 *
 * The library is the runtime counterpart to the persisted `AgentConfig`
 * (CONTEXT.md): an `AgentLoop` is constructed in code from an
 * {@link AgentLoopOptions} bag and runs a single tool-calling loop per
 * `.run()` call.
 *
 * Related: ADR-0019 (library purity boundary).
 */

import type { AgentError } from "./errors";

import type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StepResult,
  TimeoutConfiguration,
  ToolSet,
} from "ai";

// `streamText` is imported as a value solely so its parameter type can be
// queried for the SDK's `ProviderOptions` shape — the `"ai"` entrypoint does
// not re-export the `ProviderOptions` name, and its canonical source
// (`@ai-sdk/provider-utils`) is a transitive dependency that is not resolvable
// from this project. Deriving the type from the function it will be passed to
// guarantees structural identity without a hard dependency.
import { streamText } from "ai";

// ─── Provider options (derived) ──────────────────────────────────────────

/**
 * Provider-specific options, structurally identical to the AI SDK's own
 * `ProviderOptions` (the type accepted by `streamText`'s `providerOptions`
 * field). Derived rather than imported; see the module docstring.
 */
export type ProviderOptions = NonNullable<
  NonNullable<Parameters<typeof streamText>[0]["providerOptions"]>
>;

// ─── Finish reason ───────────────────────────────────────────────────────

/**
 * Why an agent run terminated. Mirrors the SDK's per-step `FinishReason` for
 * the pass-through cases (`stop`, `length`, `content-filter`, `other`) and
 * adds three loop-controlled outcomes:
 *
 * - `error`     — a stream-terminating error occurred (see {@link AgentLoopRunResult["error"]}).
 * - `aborted`   — the run was aborted (via the input signal or `handle.abort()`).
 * - `max-steps` — the configured step budget was exhausted while the model was
 *                 still requesting tool calls.
 */
export type AgentFinishReason =
  | "stop"
  | "length"
  | "content-filter"
  | "other"
  | "error"
  | "aborted"
  | "max-steps";

// ─── Options ─────────────────────────────────────────────────────────────

/**
 * The full behavior bundle used to construct an {@link AgentLoop}. A code-only
 * type — no glossary entry; the persisted counterpart is `AgentConfig`.
 *
 * `maxSteps` is **required** (no default): the loop must know its budget up
 * front. `tools` is always passed through (pass `{}` explicitly when no tools
 * are needed). Sampling/transport fields map 1:1 onto `streamText` options.
 */
export interface AgentLoopOptions {
  /** The bound language model (from the provider factory). */
  model: LanguageModel;
  /** System prompt sent on every step; NOT a `SystemModelMessage` in the input. */
  systemPrompt: string;
  /** Tools accessible to the model. Pass `{}` explicitly when none. */
  tools: ToolSet;
  /** Maximum number of steps before the loop forces `finishReason: 'max-steps'`. Required. */
  maxSteps: number;
  /** Sampling temperature. Pass-through to `streamText`. */
  temperature?: number;
  /** Nucleus sampling. Pass-through to `streamText`. */
  topP?: number;
  /** Max tokens generated per step. Pass-through to `streamText`. */
  maxOutputTokens?: number;
  /** Transport retries; SDK default is 2. Pass-through to `streamText`. */
  maxRetries?: number;
  /** Per-call timeout. `number` is the `totalMs` shorthand. Pass-through to `streamText`. */
  timeout?: TimeoutConfiguration<ToolSet>;
  /** Provider-specific options. Pass-through to `streamText`. */
  providerOptions?: ProviderOptions;
}

// ─── Run input ───────────────────────────────────────────────────────────

/**
 * A pure transform applied to the model input at EVERY `streamText`
 * boundary (each step, including the first). The loop stays application-
 * agnostic — callers supply domain-specific shaping (e.g. delete-snapshot
 * compaction from the pipeline, ADR-0028).
 *
 * Contract: MUST be pure (same input → same output), MUST NOT mutate the
 * input array or its elements, and MUST preserve array length (the caller's
 * `inputLength` bookkeeping for delta slicing depends on it). Transforms
 * reshape what the MODEL sees only — the loop's working array, run result,
 * and persisted deltas always carry the untransformed originals.
 */
export type ModelInputTransform = (messages: ModelMessage[]) => ModelMessage[];

/**
 * Input to a single {@link AgentLoop.run} call.
 *
 * `messages` is the conversation thread **without** a `SystemModelMessage` —
 * the system prompt lives on {@link AgentLoopOptions.systemPrompt}. The array
 * is defensively copied on entry and never mutated.
 */
export interface AgentLoopRunInput {
  /** Conversation thread (no system message). Never mutated by the agent. */
  messages: ModelMessage[];
  /**
   * Optional per-run override of `AgentLoopOptions.systemPrompt`. Use when
   * the system prompt depends on live session state (e.g. Plan mode
   * reminder injection — ADR-0028). When omitted, the constructor's
   * `systemPrompt` is used as the fallback.
   */
  systemPrompt?: string;
  /** Optional external abort signal; forwarded to the internal controller. */
  abortSignal?: AbortSignal;
  /**
   * Optional pure transform applied to `messages` at every `streamText`
   * boundary (see {@link ModelInputTransform}). Covers both the entry
   * thread and in-run accumulated tool results, so payload hygiene holds
   * for multi-step runs without the caller pre-transforming the input.
   */
  inputTransform?: ModelInputTransform;
}

// ─── Run result ──────────────────────────────────────────────────────────

/**
 * The outcome of an agent run. Frozen (both the result object and its
 * `messages` array) to prevent callers from mutating accumulated state.
 *
 * `steps` is the raw SDK {@link StepResult} list, re-exported verbatim — no
 * project-specific wrapping. `error` is present **iff** `finishReason === 'error'`.
 */
export interface AgentLoopRunResult {
  /** Ephemeral UUID v4 identifying this run (not persisted). */
  runId: string;
  /** Why the run terminated. */
  finishReason: AgentFinishReason;
  /** Fresh frozen array of `[...input, ...allResponses]`. */
  messages: ModelMessage[];
  /** Concatenated text from the final step (`''` if no steps completed). */
  finalText: string;
  /** Token usage summed across all completed steps. */
  totalUsage: LanguageModelUsage;
  /** Raw SDK step results, one entry per completed step. */
  steps: StepResult<ToolSet>[];
  /** Present iff `finishReason === 'error'`; `undefined` otherwise. */
  error?: AgentError;
}
