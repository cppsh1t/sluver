/**
 * AI Config IPC API.
 *
 * Space-scoped provider credentials + agent model bindings (ADR-0012), plus
 * the global models.dev catalog. All Space-scoped commands take `spaceId`
 * first, matching the convention used by the Space/World command surfaces.
 *
 * API keys are stored as plaintext in `space.db` (ADR-0013) — the threat
 * model accepts this because the Space is already behind an argon2id gate.
 */

import type { Agent, ModelsDevCatalog, ProviderCredential } from "@/types";
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
 * any agent whose `modelId` starts with `"{providerId}/"` is cleared.
 */
export function deleteProviderCredential(spaceId: string, id: string): Promise<void> {
  return call<void>("delete_provider_credential", { spaceId, id });
}

// ─── Agents (Space-scoped, read + update model only) ────────────────────────

export function listAgents(spaceId: string): Promise<Agent[]> {
  return call<Agent[]>("list_agents", { spaceId });
}

/**
 * Bind (or clear) an agent's model. Pass `null` to unset.
 * Returns the updated agent.
 */
export function updateAgentModel(
  spaceId: string,
  id: string,
  modelId: string | null,
): Promise<Agent> {
  return call<Agent>("update_agent_model", { spaceId, id, modelId });
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
