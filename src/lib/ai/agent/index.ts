/**
 * Agent runtime library — framework-agnostic AI agent execution.
 *
 * Public surface:
 * - {@link ./agent}        — the `Agent` class + `AgentRunHandle` (the loop).
 * - {@link ./types}        — `AgentOptions`, `AgentRunInput`, `AgentRunResult`, `AgentFinishReason`.
 * - {@link ./events}       — `AgentEvent` discriminated union + `AgentEmitter`.
 * - {@link ./errors}       — `AgentError` taxonomy + `classifyFromSdkError`.
 * - {@link ./define-tool}  — `defineTool` convention enforcer.
 *
 * The library re-exports a handful of SDK types so consumers can import
 * everything from `@/lib/ai/agent` instead of reaching into `"ai"` directly.
 *
 * Related: ADR-0019 (library purity boundary).
 */

// Runtime + handle
export { Agent, type AgentRunHandle } from "./agent";

// Contracts
export type {
  AgentFinishReason,
  AgentOptions,
  AgentRunInput,
  AgentRunResult,
  ProviderOptions,
} from "./types";

// Events
export { AgentEmitter, type AgentEvent, type AgentEventListener } from "./events";

// Errors
export {
  AgentError,
  classifyFromSdkError,
  ConfigError,
  extractMessage,
  ProviderError,
  StreamError,
  ToolError,
  UnknownError,
} from "./errors";

// Tool definition
export { defineTool } from "./define-tool";

// SDK type re-exports (so consumers import from here, not `"ai"`)
export type {
  LanguageModel,
  LanguageModelUsage,
  ModelMessage,
  StepResult,
  Tool,
  ToolSet,
} from "ai";
