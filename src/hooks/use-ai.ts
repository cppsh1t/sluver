import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteProviderCredential,
  getModelsDevCatalog,
  listAgents,
  listProviderCredentials,
  refreshModelsDevCatalog,
  setProviderCredential,
  updateAgentModel,
} from "@/api";
import type { ProviderCredentialId, SpaceId } from "@/types";

// Hooks are toast-free on purpose: components own success/error UX so the
// same hook is reusable across pages that surface errors differently. The
// api client already normalizes rejections to `ErrorPayload`; call sites
// should pipe `.catch`/`onError` through `translateError(toErrorPayload(e))`
// (see AGENTS.md §Error translation pipeline).

// ─── Query key factory ──────────────────────────────────────────────────────

/**
 * Query keys for the AI config surface. Each Space gets its own key namespace
 * so cache invalidation can be scoped precisely. The catalog is global — it
 * has no `spaceId` dimension.
 */
export const aiKeys = {
  providers: (spaceId: SpaceId) => ["ai", "providers", spaceId] as const,
  agents: (spaceId: SpaceId) => ["ai", "agents", spaceId] as const,
  catalog: () => ["ai", "catalog"] as const,
};

// ─── Provider credentials ───────────────────────────────────────────────────

export const useProviderCredentials = (spaceId: SpaceId) =>
  useQuery({
    queryKey: aiKeys.providers(spaceId),
    queryFn: () => listProviderCredentials(spaceId),
    enabled: !!spaceId,
  });

export const useSetProviderCredential = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      providerId,
      apiKey,
    }: {
      providerId: string;
      apiKey: string;
    }) => setProviderCredential(spaceId, providerId, apiKey),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.providers(spaceId) }),
  });
};

export const useDeleteProviderCredential = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ProviderCredentialId) =>
      deleteProviderCredential(spaceId, id),
    onSuccess: () => {
      // Deleting a provider cascades server-side: agents bound to that
      // provider's models get their `modelId` cleared, so the agent cache
      // must be refreshed alongside the provider list.
      qc.invalidateQueries({ queryKey: aiKeys.providers(spaceId) });
      qc.invalidateQueries({ queryKey: aiKeys.agents(spaceId) });
    },
  });
};

// ─── Agents ──────────────────────────────────────────────────────────────────

export const useAgents = (spaceId: SpaceId) =>
  useQuery({
    queryKey: aiKeys.agents(spaceId),
    queryFn: () => listAgents(spaceId),
    enabled: !!spaceId,
  });

export const useUpdateAgentModel = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      modelId,
    }: {
      id: string;
      modelId: string | null;
    }) => updateAgentModel(spaceId, id, modelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.agents(spaceId) }),
  });
};

// ─── Models.dev catalog (global) ─────────────────────────────────────────────

/**
 * The catalog's freshness is controlled server-side (24h TTL + stale
 * fallback), so a very long `staleTime` here avoids redundant IPC round
 * trips — the data won't change until the user explicitly refreshes.
 */
export const useModelsDevCatalog = () =>
  useQuery({
    queryKey: aiKeys.catalog(),
    queryFn: getModelsDevCatalog,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useRefreshModelsDevCatalog = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshModelsDevCatalog,
    onSuccess: () => qc.invalidateQueries({ queryKey: aiKeys.catalog() }),
  });
};
