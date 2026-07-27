/**
 * Error taxonomy for the Agent runtime library.
 *
 * Every failure surfaced by the runtime is an {@link AgentError}. Each variant
 * carries three classification flags that a future recovery wrapper can act on:
 *
 * - `code`      — a stable, `SHOUTING-KEBAB`-style string (e.g. `'PROVIDER_ERROR'`)
 *                 suitable for log fields and i18n keys.
 * - `retryable` — hint that a transient failure might succeed on retry (v1 does
 *                 not retry; the flag exists for the future wrapper).
 * - `fatal`     — whether the error terminates the whole run. **Non-fatal**
 *                 errors ({@link ToolError}) never cross the loop boundary —
 *                 they are emitted as `tool_error` events and the run continues.
 *
 * {@link classifyFromSdkError} normalises an arbitrary thrown value into this
 * taxonomy using the SDK's cross-realm `isInstance()` guards (which survive
 * module duplication / realm boundaries better than `instanceof`).
 *
 * Related: ADR-0019 (library purity boundary).
 */

import {
  APICallError,
  InvalidToolInputError,
  NoOutputGeneratedError,
  NoSuchToolError,
} from "ai";

// ─── Base ────────────────────────────────────────────────────────────────

/**
 * Abstract base for every runtime error. Subclasses set `name` to their class
 * name (matching the existing `ProviderFactoryError` convention) and fix the
 * classification flags.
 *
 * The original thrown value is preserved on {@link AgentError.cause}. It is
 * declared explicitly here because the project's `lib` is ES2020, which
 * predates the standard `Error.cause` constructor option — at runtime (a modern
 * Chromium WebView) `cause` is a normal enumerable own property.
 */
export abstract class AgentError extends Error {
  abstract readonly code: string;
  abstract readonly retryable: boolean;
  abstract readonly fatal: boolean;
  /** The original thrown value, if any. See class docstring. */
  cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

// ─── Subclasses ──────────────────────────────────────────────────────────

/**
 * Invalid or missing {@link AgentOptions} — e.g. `maxSteps < 1`, or a second
 * `.run()` invoked while a run is already active (`AGENT_ALREADY_RUNNING`).
 * Not retryable; always fatal.
 */
export class ConfigError extends AgentError {
  readonly code = "CONFIG_ERROR";
  readonly retryable = false;
  readonly fatal = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ConfigError";
  }
}

/**
 * HTTP / transport failure from the model provider (e.g. 5xx, network). Whether
 * it is `retryable` is provider-determined (mirrors `APICallError.isRetryable`);
 * always fatal to the current run.
 */
export class ProviderError extends AgentError {
  readonly code = "PROVIDER_ERROR";
  readonly retryable: boolean;
  readonly fatal = true;

  constructor(message: string, retryable: boolean, cause?: unknown) {
    super(message, cause);
    this.name = "ProviderError";
    this.retryable = retryable;
  }
}

/**
 * Stream plumbing failure (e.g. the model produced no parsable output, the
 * stream was malformed). Not retryable; always fatal.
 */
export class StreamError extends AgentError {
  readonly code = "STREAM_ERROR";
  readonly retryable = false;
  readonly fatal = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "StreamError";
  }
}

/**
 * A tool's `execute()` rejected, or its input failed schema validation. Surfaced
 * as the payload of a `tool_error` **event**, never thrown across the loop —
 * hence `fatal: false`. The SDK feeds the error back to the model so it can
 * adapt; the run continues.
 */
export class ToolError extends AgentError {
  readonly code = "TOOL_ERROR";
  readonly retryable = false;
  readonly fatal = false;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "ToolError";
  }
}

/**
 * Fallback for anything the classifier does not recognise. Not retryable; fatal.
 */
export class UnknownError extends AgentError {
  readonly code = "UNKNOWN";
  readonly retryable = false;
  readonly fatal = true;

  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "UnknownError";
  }
}

// ─── Classification ──────────────────────────────────────────────────────

/** Best-effort string extraction from an arbitrary thrown value. */
export function extractMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/**
 * Normalise an arbitrary thrown value into the {@link AgentError} taxonomy.
 *
 * Uses the SDK's cross-realm `isInstance()` guards (not `instanceof`) so this
 * stays correct even if the SDK is duplicated across chunks. Abort is **not**
 * classified here — the SDK surfaces abort as an `abort` stream part (there is
 * no `AbortError` class), and the loop handles it separately.
 *
 * The original error is preserved on the resulting error's `cause`.
 */
export function classifyFromSdkError(value: unknown): AgentError {
  // Provider HTTP / transport failures. `isRetryable` is provider-determined
  // (e.g. idempotent 5xx vs. a hard 4xx), so it flows through to ProviderError.
  if (APICallError.isInstance(value)) {
    return new ProviderError(extractMessage(value), value.isRetryable, value);
  }

  // The model returned no usable output — a stream-level failure.
  if (NoOutputGeneratedError.isInstance(value)) {
    return new StreamError(extractMessage(value), value);
  }

  // Tool-side failures. These surface as `tool_error` events when they arrive
  // via stream parts, but if they are thrown directly they classify the same.
  if (NoSuchToolError.isInstance(value)) {
    return new ToolError(extractMessage(value), value);
  }
  if (InvalidToolInputError.isInstance(value)) {
    return new ToolError(extractMessage(value), value);
  }

  if (value instanceof AgentError) {
    return value;
  }

  return new UnknownError(extractMessage(value), value);
}
