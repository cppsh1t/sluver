import { z } from "zod";

/**
 * AI 配置（AI Config）— Space-scoped provider 凭证 + agent model 选择。
 *
 * Two tables in `space.db` (see ADR-0012 Space-scoped AI config):
 *  - `provider_credentials` — one row per provider (anthropic / openai / …),
 *    keyed by `provider_id` which aligns with the models.dev catalog.
 *  - `agents` — seeded rows (`explorer`, `writer`); each points its
 *    `model_id` at a `"{providerId}/{modelId}"` string.
 *
 * The catalog (`ModelsDevCatalog`) is a global, non-Space-scoped snapshot of
 * https://models.dev/api.json, cached on disk with a 24h TTL. Its shape is
 * intentionally lenient (`z.record`) so upstream additions don't break parse.
 *
 * Related: ADR-0013 (API keys stored as plaintext in space.db).
 */

// ─── Branded IDs ────────────────────────────────────────────────────────────

/** Branded ID for a provider credential row. Prevents ID mix-ups. */
export const providerCredentialIdSchema = z.string().brand<"ProviderCredentialId">();
export type ProviderCredentialId = z.infer<typeof providerCredentialIdSchema>;

/** Branded ID for an agent row. */
export const agentIdSchema = z.string().brand<"AgentId">();
export type AgentId = z.infer<typeof agentIdSchema>;

// ─── ProviderCredential ─────────────────────────────────────────────────────

/**
 * A stored API key for a single provider.
 *
 * Mirrors the Rust `ProviderCredential` struct (`#[serde(rename_all =
 * "camelCase")]`). The `apiKey` is plaintext (ADR-0013) — the threat model
 * accepts this because Space.db is already behind the Space password gate.
 */
export const providerCredentialSchema = z.object({
  id: providerCredentialIdSchema,
  /** models.dev provider id, e.g. `"anthropic"`, `"openai"`. */
  providerId: z.string(),
  /** Plaintext API key (ADR-0013). */
  apiKey: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type ProviderCredential = z.infer<typeof providerCredentialSchema>;

/** Payload for `set_provider_credential` (UPSERT on `providerId`). */
export const setProviderCredentialInputSchema = z.object({
  providerId: z.string().min(1),
  apiKey: z.string().min(1),
});

export type SetProviderCredentialInput = z.infer<typeof setProviderCredentialInputSchema>;

// ─── Agent ──────────────────────────────────────────────────────────────────

/**
 * A built-in agent (`explorer` or `writer`). Seeded at Space creation; the
 * frontend never creates or deletes agents — only updates `modelId`.
 *
 * `modelId` follows the `"{providerId}/{modelId}"` convention (e.g.
 * `"anthropic/claude-sonnet-5"`), or `null` when unset.
 */
export const agentSchema = z.object({
  id: agentIdSchema,
  /** Stable name: `"explorer"` or `"writer"`. */
  name: z.string(),
  /** `"{providerId}/{modelId}"`, or `null` when no model is chosen. */
  modelId: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Agent = z.infer<typeof agentSchema>;

// ─── Models.dev catalog ─────────────────────────────────────────────────────

/**
 * A single model entry in the catalog. Only the fields the frontend needs
 * are surfaced; upstream extras (modalities, pricing, context window) are
 * dropped by the Rust adapter.
 */
export const catalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export type CatalogModel = z.infer<typeof catalogModelSchema>;

/**
 * A single provider entry in the catalog. `npm` and `iconUrl` are optional
 * because not every provider publishes them.
 */
export const catalogProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  npm: z.string().nullable().optional(),
  iconUrl: z.string().nullable().optional(),
  models: z.array(catalogModelSchema),
});

export type CatalogProvider = z.infer<typeof catalogProviderSchema>;

/**
 * The full catalog snapshot.
 *
 * `isStale = true` means the fresh fetch failed and this is the last good
 * copy — the UI surfaces a warning banner so the user knows models may be
 * outdated. `fetchedAt` is an ISO timestamp of the *stored* copy (not the
 * failed attempt).
 */
export const modelsDevCatalogSchema = z.object({
  providers: z.array(catalogProviderSchema),
  fetchedAt: z.iso.datetime(),
  isStale: z.boolean(),
});

export type ModelsDevCatalog = z.infer<typeof modelsDevCatalogSchema>;
