/**
 * Agent factory — resolves a {@link ResolvedModelConfig} + options into a
 * ready-to-use {@link ToolLoopAgent}. Sits above the provider layer
 * (`createLanguageModel`) and below the React hook (`useConversation`).
 *
 * Related: ADR-0017 (frontend agent loop, no two-layer custom messages).
 */
import { ToolLoopAgent, type LanguageModel, type ToolSet } from "ai";

import { logger } from "@/lib/logger";

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
 *
 * Throws if the provider package cannot be resolved (e.g. catalog `npm`
 * field points to an uninstalled `@ai-sdk/*` package). The underlying
 * `ProviderFactoryError` is logged at WARN before being re-thrown so the
 * diagnostic trail is preserved even if the caller swallows the throw.
 */
export function createAgent(
  config: ResolvedModelConfig,
  options: CreateAgentOptions,
): ToolLoopAgent {
  let model: LanguageModel;
  try {
    model = createLanguageModel(config);
  } catch (err) {
    // `createLanguageModel` is the only fallible step — catalog `npm` field
    // may point at a package that isn't installed, or the package may not
    // export a `create*` factory. Log structured context for diagnostics,
    // then re-throw so the caller's own error path runs.
    logger.warn("ai.provider.resolve_failed", {
      npm_package: config.npmPackage,
      model_id: config.modelId,
      error_name: err instanceof Error ? err.name : "unknown",
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  logger.debug("ai.agent.created", {
    npm_package: config.npmPackage,
    model_id: config.modelId,
    tools_count: options.tools ? Object.keys(options.tools).length : 0,
  });

  return new ToolLoopAgent({
    model,
    instructions: options.instructions,
    tools: options.tools ?? {},
  });
}
