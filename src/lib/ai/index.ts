/**
 * AI provider factory module — "抹平 @ai-sdk/* 库依赖差异".
 *
 * Barrel export for the provider factory layer. See individual module
 * docstrings for details:
 *  - {@link "./provider-factory"} — `createLanguageModel()` + types + auto-discovery
 *  - {@link "./provider-modules"} — installed package map (synced with package.json)
 *  - {@link "./model-id"} — composite `"{providerId}/{modelId}"` utilities
 *
 * ## Quick start
 *
 * ```ts
 * import { createLanguageModel } from "@/lib/ai";
 * import { generateText } from "ai";
 *
 * const model = createLanguageModel(config);
 * const { text } = await generateText({ model, prompt: "Hello" });
 * ```
 */

export { composeModelId, parseModelId } from "./model-id";
export {
  createLanguageModel,
  ProviderFactoryError,
  type ResolvedModelConfig,
} from "./provider-factory";
export { PROVIDER_MODULES } from "./provider-modules";
