/**
 * Installed AI SDK provider modules.
 *
 * This file lists the provider packages installed in `package.json` so that
 * Vite can statically analyse and bundle them. The actual **factory function
 * discovery is automatic** — each `@ai-sdk/*` package exports exactly one
 * `create*` function, found at runtime by `provider-factory.ts`.
 *
 * ## What this file is NOT
 *
 * It is **not** a provider → factory mapping table. The models.dev catalog
 * already stores which npm package each provider uses (`npm` field). This file
 * only declares "these packages are installed" — the same information as
 * `package.json` dependencies.
 *
 * ## Adding a new provider
 *
 * 1. `pnpm add @ai-sdk/new-provider`
 * 2. Add one line here: `import * as newProvider from "@ai-sdk/new-provider";`
 * 3. Add one entry: `"@ai-sdk/new-provider": newProvider,`
 *
 * No factory function names, no provider-id mappings — those are resolved
 * dynamically from the catalog and the package's own exports.
 */

import * as amazonBedrock from "@ai-sdk/amazon-bedrock";
import * as anthropic from "@ai-sdk/anthropic";
import * as azure from "@ai-sdk/azure";
import * as cerebras from "@ai-sdk/cerebras";
import * as cohere from "@ai-sdk/cohere";
import * as deepInfra from "@ai-sdk/deepinfra";
import * as deepSeek from "@ai-sdk/deepseek";
import * as gateway from "@ai-sdk/gateway";
import * as google from "@ai-sdk/google";
import * as googleVertex from "@ai-sdk/google-vertex";
import * as groq from "@ai-sdk/groq";
import * as mistral from "@ai-sdk/mistral";
import * as openai from "@ai-sdk/openai";
import * as openaiCompatible from "@ai-sdk/openai-compatible";
import * as perplexity from "@ai-sdk/perplexity";
import * as togetherAI from "@ai-sdk/togetherai";
import * as vercel from "@ai-sdk/vercel";
import * as xai from "@ai-sdk/xai";
// ─── Community providers ────────────────────────────────────────────────
import * as aihubmix from "@aihubmix/ai-sdk-provider";
import * as gitLab from "gitlab-ai-provider";
import * as mergeGateway from "merge-gateway-ai-sdk-provider";
import * as openRouter from "@openrouter/ai-sdk-provider";
import * as sapAI from "@jerome-benoit/sap-ai-provider-v2";
import * as venice from "venice-ai-sdk-provider";

/**
 * Lookup table: npm package name → module namespace.
 *
 * Values are typed as `Record<string, unknown>` because factory discovery is
 * runtime-based (see `findFactory`). The source modules retain their full
 * TypeScript types for consumers that import them directly.
 */
export const PROVIDER_MODULES: Readonly<Record<string, Record<string, unknown>>> =
  Object.freeze({
    // ─── Official @ai-sdk/* providers ──────────────────────────────────
    "@ai-sdk/openai": openai as unknown as Record<string, unknown>,
    "@ai-sdk/anthropic": anthropic as unknown as Record<string, unknown>,
    "@ai-sdk/google": google as unknown as Record<string, unknown>,
    "@ai-sdk/mistral": mistral as unknown as Record<string, unknown>,
    "@ai-sdk/cohere": cohere as unknown as Record<string, unknown>,
    "@ai-sdk/groq": groq as unknown as Record<string, unknown>,
    "@ai-sdk/xai": xai as unknown as Record<string, unknown>,
    "@ai-sdk/deepseek": deepSeek as unknown as Record<string, unknown>,
    "@ai-sdk/perplexity": perplexity as unknown as Record<string, unknown>,
    "@ai-sdk/togetherai": togetherAI as unknown as Record<string, unknown>,
    "@ai-sdk/cerebras": cerebras as unknown as Record<string, unknown>,
    "@ai-sdk/deepinfra": deepInfra as unknown as Record<string, unknown>,
    "@ai-sdk/amazon-bedrock": amazonBedrock as unknown as Record<string, unknown>,
    "@ai-sdk/google-vertex": googleVertex as unknown as Record<string, unknown>,
    "@ai-sdk/azure": azure as unknown as Record<string, unknown>,
    "@ai-sdk/gateway": gateway as unknown as Record<string, unknown>,
    "@ai-sdk/vercel": vercel as unknown as Record<string, unknown>,
    "@ai-sdk/openai-compatible": openaiCompatible as unknown as Record<string, unknown>,

    // ─── Community providers ───────────────────────────────────────────
    "@openrouter/ai-sdk-provider": openRouter as unknown as Record<string, unknown>,
    "@aihubmix/ai-sdk-provider": aihubmix as unknown as Record<string, unknown>,
    "gitlab-ai-provider": gitLab as unknown as Record<string, unknown>,
    "merge-gateway-ai-sdk-provider": mergeGateway as unknown as Record<string, unknown>,
    "venice-ai-sdk-provider": venice as unknown as Record<string, unknown>,
    "@jerome-benoit/sap-ai-provider-v2": sapAI as unknown as Record<string, unknown>,
  });
