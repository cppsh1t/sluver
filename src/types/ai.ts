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

/** Branded ID for an agent config row. */
export const agentConfigIdSchema = z.string().brand<"AgentConfigId">();
export type AgentConfigId = z.infer<typeof agentConfigIdSchema>;

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

// ─── Context compaction ─────────────────────────────────────────────────────

/**
 * Per-role Context-mode compaction config (ADR-0031 Phase 1).
 *
 * When `enabled`, the Derived Model Input pipeline replaces aged tool-call +
 * tool-result pairs with short text stubs (scheme Z — see ADR-0031 §3). The
 * `turnAge` threshold controls how many recent turns keep their full tool
 * detail; turns older than the threshold are compacted. The original
 * (uncompacted) pair is always recoverable by the model via the
 * `context_read` tool.
 *
 * Defaults: `enabled = false`, `turnAge = 3`. Per-role opt-in matches the
 * heterogeneous conversation lengths across roles (Writer runs long, Explorer
 * runs short) — ADR-0031 §1.
 */
export const contextCompactionSchema = z.object({
  /** Whether stub compaction is active for this role. Default `false`. */
  enabled: z.boolean(),
  /**
   * Number of recent user-turns whose tool calls are kept verbatim. `turnAge`
   * of 0 compacts every prior turn (only the current turn is preserved). Must
   * be a positive integer in the schema; the ADR's "default 3" is enforced by
   * the DB seed + the role's `CompactionPolicy`, not by this schema.
   */
  turnAge: z.number().int().positive(),
});

export type ContextCompaction = z.infer<typeof contextCompactionSchema>;

// ─── AgentConfig ────────────────────────────────────────────────────────────

/**
 * A built-in agent config (`explorer` or `writer`). Seeded at Space creation;
 * the frontend never creates or deletes agent configs — only updates `modelId`.
 *
 * `modelId` follows the `"{providerId}/{modelId}"` convention (e.g.
 * `"anthropic/claude-sonnet-5"`), or `null` when unset.
 */
export const agentConfigSchema = z.object({
  id: agentConfigIdSchema,
  /** Stable name: `"explorer"` or `"writer"`. */
  name: z.string(),
  /** `"{providerId}/{modelId}"`, or `null` when no model is chosen. */
  modelId: z.string().nullable(),
  /**
   * When `true`, dangerous (creation-type) tools execute immediately without
   * asking for confirmation each time. Defaults to `false`.
   */
  autoExecuteDangerousTools: z.boolean(),
  /**
   * When `true`, the shell execution tool (`run_shell_command`) is
   * registered on the explorer role and auto-executes (ADR-0042,
   * supersedes ADR-0041 §2). Defaults to `false` (the DB DDL owns the
   * default; Rust always serializes this field).
   */
  shellToolEnabled: z.boolean(),
  /**
   * Per-role Context-mode compaction config (ADR-0031 Phase 1). Controls
   * whether aged tool-call + tool-result pairs are stubbed in the Derived
   * Model Input. Read by the conversation-runtime at Agent construction time
   * and converted to a library-side `CompactionPolicy`.
   */
  contextCompaction: contextCompactionSchema,
  /**
   * Per-role system prompt override. Empty string = use the code-defined
   * default (see `src/lib/ai-roles/index.ts` `ROLE_BEHAVIOR`). A non-empty
   * value replaces the role's system prompt for this Space.
   */
  systemPrompt: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;

// ─── Models.dev catalog ─────────────────────────────────────────────────────

/**
 * A single model entry in the catalog. Only the fields the frontend needs
 * are surfaced; other upstream extras (modalities, pricing) are dropped by
 * the Rust adapter.
 */
export const catalogModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  /**
   * Maximum context window in tokens, surfaced from the upstream `limit`
   * field by the Rust adapter (`context_window` → camelCase `contextWindow`).
   * `null` when upstream omits it (common for self-hosted OpenAI-compatible
   * providers). Consumed by the chat context-occupancy indicator
   * (ADR-0030 §6). `undefined` only before the catalog query resolves.
   */
  contextWindow: z.number().nullable().optional(),
  /**
   * Input modalities from the upstream models.dev `modalities.input` array
   * (e.g. `["text", "image"]`), surfaced by the Rust adapter as camelCase
   * `inputModalities`. `null` when upstream omits the field (the adapter
   * filters empty arrays into `None` so `null` reliably means "unknown",
   * never "known empty"). This is the vision-capability signal
   * (`includes("image")`) for the catalog-driven downgrade flow
   * (ADR-0044 §D9).
   */
  inputModalities: z.array(z.string()).nullable().optional(),
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
  /** Provider API base URL (upstream `api` field). Required for openai-compatible providers. */
  apiBaseUrl: z.string().nullable().optional(),
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
