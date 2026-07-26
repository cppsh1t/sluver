/**
 * Provider factory — the core "抹平库依赖差异" layer.
 *
 * Given a resolved model configuration (npm package + model id + API key),
 * this module produces a ready-to-use {@link LanguageModel} for the AI SDK v7
 * `generateText` / `streamText` functions.
 *
 * ## How it works
 *
 * 1. The models.dev catalog tells us **which npm package** to use (the `npm`
 *    field, e.g. `"@ai-sdk/anthropic"`).
 * 2. We look up that package in {@link PROVIDER_MODULES} (a map of installed
 *    packages, kept in sync with `package.json`).
 * 3. We **auto-discover** the factory function: every `@ai-sdk/*` package
 *    exports exactly one `create*` function — we find it by scanning the
 *    module's exports at runtime. No hardcoded function-name mapping.
 * 4. We call `factory({ apiKey })` → `provider(modelId)` → `LanguageModel`.
 *
 * ## Usage
 *
 * ```ts
 * import { createLanguageModel } from "@/lib/ai";
 * import { generateText } from "ai";
 *
 * const model = createLanguageModel({
 *   npmPackage: "@ai-sdk/anthropic",   // from catalog's `npm` field
 *   modelId: "claude-sonnet-5",        // from agent's bound model
 *   apiKey: storedApiKey,              // from provider_credentials
 * });
 *
 * const { text } = await generateText({
 *   model,
 *   instructions: "You are a novelist.",
 *   prompt: "Write a short scene about...",
 * });
 * ```
 *
 * Related: ADR-0012 (Space-scoped AI config), ADR-0013 (API key plaintext).
 */

import type { LanguageModel } from "ai";

import { PROVIDER_MODULES } from "./provider-modules";

// ─── Types ──────────────────────────────────────────────────────────────

/**
 * Everything needed to create a `LanguageModel`, resolved from the catalog
 * (`npmPackage`), the agent (`modelId`), and `provider_credentials` (`apiKey`).
 *
 * Use {@link parseModelId} to split an agent's composite modelId
 * (`"anthropic/claude-sonnet-5"`) into provider + model parts.
 */
export interface ResolvedModelConfig {
  /**
   * The npm package from the catalog's `npm` field, e.g. `"@ai-sdk/anthropic"`.
   * This determines which installed module is loaded and which factory function
   * is auto-discovered.
   */
  npmPackage: string;
  /** The model id within the provider, e.g. `"claude-sonnet-5"`. */
  modelId: string;
  /** Plaintext API key from `provider_credentials` (ADR-0013). */
  apiKey: string;
}

// ─── Error ──────────────────────────────────────────────────────────────

/**
 * Thrown when the catalog's `npm` field doesn't match any installed package,
 * or when a package's factory function can't be auto-discovered.
 */
export class ProviderFactoryError extends Error {
  constructor(
    message: string,
    /** The npm package string from the catalog that caused the failure. */
    readonly npmPackage: string,
  ) {
    super(message);
    this.name = "ProviderFactoryError";
  }
}

// ─── Factory discovery ──────────────────────────────────────────────────

/** A normalised factory: `{ apiKey }` → callable provider → `LanguageModel`. */
type AnyProviderFactory = (options: {
  apiKey: string;
}) => (modelId: string) => LanguageModel;

/**
 * Find the `create*` factory function in a provider module.
 *
 * Every `@ai-sdk/*` package exports exactly one function whose name starts
 * with `"create"` — that's the factory. If there are zero or multiple matches,
 * the package doesn't follow the AI SDK convention and we can't auto-discover.
 *
 * @throws {ProviderFactoryError} if zero or multiple `create*` exports found.
 */
function findFactory(
  mod: Record<string, unknown>,
  npmPackage: string,
): AnyProviderFactory {
  const candidates = Object.entries(mod).filter(
    ([key, val]) => key.startsWith("create") && typeof val === "function",
  );

  if (candidates.length === 0) {
    throw new ProviderFactoryError(
      `Package "${npmPackage}" does not export a create* function. It may not be an AI SDK provider package.`,
      npmPackage,
    );
  }

  if (candidates.length > 1) {
    const names = candidates.map(([k]) => k).join(", ");
    throw new ProviderFactoryError(
      `Package "${npmPackage}" exports multiple create* functions (${names}). Cannot auto-discover the factory.`,
      npmPackage,
    );
  }

  return candidates[0][1] as AnyProviderFactory;
}

// ─── Public API ─────────────────────────────────────────────────────────

/**
 * Create a {@link LanguageModel} from a resolved configuration.
 *
 * The operation is synchronous — no I/O, no network. The resulting
 * `LanguageModel` lazily makes API calls only when invoked by
 * `generateText`/`streamText`.
 *
 * @throws {ProviderFactoryError} if the package is not installed or its
 *   factory function can't be auto-discovered.
 */
export function createLanguageModel(config: ResolvedModelConfig): LanguageModel {
  const mod = PROVIDER_MODULES[config.npmPackage];
  if (!mod) {
    throw new ProviderFactoryError(
      `AI SDK package "${config.npmPackage}" is not installed. Add it to package.json dependencies.`,
      config.npmPackage,
    );
  }

  const factory = findFactory(mod, config.npmPackage);
  const provider = factory({ apiKey: config.apiKey });
  return provider(config.modelId);
}
