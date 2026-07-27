/**
 * AI module barrel — provider resolution + agent runtime.
 *
 * - {@link ./provider} — `ResolvedModelConfig → LanguageModel` (provider 抹平层)
 * - {@link ./agent}    — framework-agnostic tool-calling loop over `streamText`
 */

// ─── Provider ────────────────────────────────────────────────────────────

export {
  composeModelId,
  createLanguageModel,
  parseModelId,
  ProviderFactoryError,
  PROVIDER_MODULES,
  type ResolvedModelConfig,
} from "./provider";

// ─── Agent ───────────────────────────────────────────────────────────────

export {
  Agent,
  AgentEmitter,
  AgentError,
  classifyFromSdkError,
  ConfigError,
  defineTool,
  extractMessage,
  ProviderError,
  StreamError,
  ToolError,
  UnknownError,
  type AgentEvent,
  type AgentEventListener,
  type AgentFinishReason,
  type AgentOptions,
  type AgentRunHandle,
  type AgentRunInput,
  type AgentRunResult,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderOptions,
  type StepResult,
  type Tool,
  type ToolSet,
} from "./agent";

