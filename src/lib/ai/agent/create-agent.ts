/**
 * Agent factory — resolves a {@link ResolvedModelConfig} + options into a
 * ready-to-use {@link ToolLoopAgent}. Sits above the provider layer
 * (`createLanguageModel`) and below the React hook (`useConversation`).
 *
 * Related: ADR-0017 (frontend agent loop, no two-layer custom messages).
 */
import { ToolLoopAgent, type LanguageModel, type ToolSet } from "ai";

import { createLanguageModel, type ResolvedModelConfig } from "../provider";

export interface CreateAgentOptions {
  /** System instructions for the agent (the "system prompt"). */
  instructions: string;
  /** Toolset the agent can call. Defaults to no tools. */
  tools?: ToolSet;
}

/**
 * Create a {@link ToolLoopAgent} from a resolved model configuration.
 *
 * The agent is cheap to construct — no network calls happen until
 * `stream()`/`generate()` is invoked (typically via `useConversation`).
 */
export function createAgent(
  config: ResolvedModelConfig,
  options: CreateAgentOptions,
): ToolLoopAgent {
  const model: LanguageModel = createLanguageModel(config);
  return new ToolLoopAgent({
    model,
    instructions: options.instructions,
    tools: options.tools ?? {},
  });
}
