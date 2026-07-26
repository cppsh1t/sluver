/**
 * Provider layer barrel — "抹平 @ai-sdk/* 库依赖差异".
 *
 * Re-exports the provider factory, installed-package map, and composite
 * model-id utilities. See individual module docstrings for details.
 */

export { composeModelId, parseModelId } from "./model-id";
export {
  createLanguageModel,
  ProviderFactoryError,
  type ResolvedModelConfig,
} from "./provider-factory";
export { PROVIDER_MODULES } from "./provider-modules";
