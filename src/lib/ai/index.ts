/**
 * AI module barrel — provider resolution + agent loop.
 *
 * - {@link ./provider} — `ResolvedModelConfig → LanguageModel` (provider 抹平层)
 * - {@link ./agent} — `ToolLoopAgent` factory + `useConversation` hook (循环层)
 *
 * ## Quick start
 *
 * ```ts
 * import { createAgent } from "@/lib/ai";
 * import { useResolvedModelConfig } from "@/hooks/use-ai";
 *
 * const { config } = useResolvedModelConfig(spaceId, "writer");
 * if (!config) return;
 * const agent = createAgent(config, { instructions: "You are a novelist." });
 * ```
 */

export {
  composeModelId,
  createLanguageModel,
  parseModelId,
  ProviderFactoryError,
  PROVIDER_MODULES,
  type ResolvedModelConfig,
} from "./provider";
export {
  createAgent,
  testTools,
  useConversation,
} from "./agent";
