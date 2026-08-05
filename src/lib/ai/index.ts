/**
 * AI module barrel — provider resolution + agent runtime + session layer
 * + pipeline (Derived Model Input transforms).
 *
 * - {@link ./provider} — `ResolvedModelConfig → LanguageModel` (provider 抹平层)
 * - {@link ./loop}     — `AgentLoop`: stateless single-run tool-calling loop over `streamText`
 * - {@link ./session}  — `Agent`: stateful multi-turn wrapper with conversation memory + persistence
 * - {@link ./pipeline} — `composeSystemPrompt`: pure Plan-mode system-prompt injector (ADR-0028)
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

// ─── Loop (stateless executor) ───────────────────────────────────────────

export {
  AgentLoop,
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
  type AgentLoopOptions,
  type AgentLoopRunInput,
  type AgentLoopRunResult,
  type AgentRunHandle,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ProviderOptions,
  type StepResult,
  type Tool,
  type ToolSet,
} from "./loop";

// ─── Session (stateful wrapper) ──────────────────────────────────────────

export {
  Agent,
  type AgentOptions,
  toModelMessage,
  toSessionMessage,
  type Plan,
  type PlanItem,
  type PlanStatus,
  type SessionInit,
  type SessionMessage,
  type SessionRecord,
  type SessionStore,
} from "./session";

// ─── Pipeline (Derived Model Input transforms — ADR-0028) ────────────────

export { composeSystemPrompt } from "./pipeline";
export type { SystemPromptComposerInput } from "./pipeline";
