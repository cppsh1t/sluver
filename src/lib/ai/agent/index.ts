/**
 * Agent module barrel — conversation loop layer.
 *
 * - {@link ./create-agent} — `ResolvedModelConfig + options → ToolLoopAgent`
 * - {@link ./tools} — temporary test tools (add, time)
 * - {@link ./use-conversation} — React hook wrapping agent streaming
 *
 * Related: ADR-0017 (frontend agent loop, no two-layer custom messages).
 */
export { createAgent, type CreateAgentOptions } from "./create-agent";
export { addTool, testTools, timeTool } from "./tools";
export {
  useConversation,
  type ConversationStatus,
  type SendMessageResult,
  type UseConversationResult,
} from "./use-conversation";
