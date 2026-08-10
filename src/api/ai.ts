/**
 * AI Config IPC API.
 *
 * Space-scoped provider credentials + agent config model bindings (ADR-0012), plus
 * the global models.dev catalog. All Space-scoped commands take `spaceId`
 * first, matching the convention used by the Space/World command surfaces.
 *
 * API keys are stored as plaintext in `space.db` (ADR-0013) — the threat
 * model accepts this because the Space is already behind an argon2id gate.
 */

import type {
  AgentConfig,
  ContextCompaction,
  ModelsDevCatalog,
  ProviderCredential,
} from "@/types";
import { call } from "./client";

// ─── Provider credentials (Space-scoped) ────────────────────────────────────

export function listProviderCredentials(spaceId: string): Promise<ProviderCredential[]> {
  return call<ProviderCredential[]>("list_provider_credentials", { spaceId });
}

/**
 * UPSERT a provider credential. If `providerId` already exists, its
 * `apiKey` is updated in place (server-side `ON CONFLICT DO UPDATE`).
 */
export function setProviderCredential(
  spaceId: string,
  providerId: string,
  apiKey: string,
): Promise<ProviderCredential> {
  return call<ProviderCredential>("set_provider_credential", {
    spaceId,
    input: { providerId, apiKey },
  });
}

/**
 * Delete a provider credential by its row id. Server-side this also cascades:
 * any agent config whose `modelId` starts with `"{providerId}/"` is cleared.
 */
export function deleteProviderCredential(spaceId: string, id: string): Promise<void> {
  return call<void>("delete_provider_credential", { spaceId, id });
}

// ─── Agent configs (Space-scoped, read + update model only) ─────────────────

export function listAgentConfigs(spaceId: string): Promise<AgentConfig[]> {
  return call<AgentConfig[]>("list_agent_configs", { spaceId });
}

/**
 * Bind (or clear) an agent config's model. Pass `null` to unset.
 * Returns the updated agent config.
 */
export function updateAgentConfigModel(
  spaceId: string,
  id: string,
  modelId: string | null,
): Promise<AgentConfig> {
  return call<AgentConfig>("update_agent_config_model", { spaceId, id, modelId });
}

/**
 * Toggle an agent config's `autoExecuteDangerousTools` flag. When `true`,
 * dangerous (creation-type) tools execute immediately without per-step
 * confirmation. Returns the updated agent config.
 */
export function updateAgentConfigAutoExecute(
  spaceId: string,
  id: string,
  autoExecute: boolean,
): Promise<AgentConfig> {
  return call<AgentConfig>("update_agent_config_auto_execute", {
    spaceId,
    id,
    autoExecute,
  });
}

/**
 * Update an agent config's Context-mode compaction settings (ADR-0031 Phase 1).
 * `contextCompaction.enabled` toggles stub compaction of aged tool calls;
 * `contextCompaction.turnAge` is the user-turn age threshold (default 3).
 * Returns the updated agent config.
 */
export function updateAgentConfigContextCompaction(
  spaceId: string,
  id: string,
  contextCompaction: ContextCompaction,
): Promise<AgentConfig> {
  return call<AgentConfig>("update_agent_config_context_compaction", {
    spaceId,
    id,
    contextCompaction,
  });
}

/**
 * Update an agent config's system prompt override. Pass an empty string to
 * reset to the code-defined default. Returns the updated agent config.
 */
export function updateAgentConfigSystemPrompt(
  spaceId: string,
  id: string,
  systemPrompt: string,
): Promise<AgentConfig> {
  return call<AgentConfig>("update_agent_config_system_prompt", {
    spaceId,
    id,
    systemPrompt,
  });
}

// ─── Models.dev catalog (global, not Space-scoped) ──────────────────────────

/**
 * Get the models.dev catalog, respecting a 24h server-side TTL. If the
 * cached copy is fresh it is returned directly; otherwise a new fetch is
 * attempted. On fetch failure with a stale local copy, `isStale = true`.
 */
export function getModelsDevCatalog(): Promise<ModelsDevCatalog> {
  return call<ModelsDevCatalog>("get_models_dev_catalog");
}

/** Force-refresh the catalog, bypassing the TTL. Same failure behavior as get. */
export function refreshModelsDevCatalog(): Promise<ModelsDevCatalog> {
  return call<ModelsDevCatalog>("refresh_models_dev_catalog");
}
