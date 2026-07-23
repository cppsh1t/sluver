import { useMemo } from "react";
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
import { parseModelId, type ResolvedModelConfig } from "@/lib/ai";
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

// ─── Resolved model config (compose agent + credential + catalog) ───────────

/**
 * Compose everything needed to call `createLanguageModel()` for a specific
 * agent, by joining three data sources:
 *
 * 1. **Agent** — its `modelId` (`"anthropic/claude-sonnet-5"`) gives us the
 *    provider id and model id via {@link parseModelId}.
 * 2. **Catalog** — the provider's `npm` field tells us which `@ai-sdk/*`
 *    package to load (e.g. `"@ai-sdk/anthropic"`).
 * 3. **Credential** — the stored `apiKey` for that provider.
 *
 * Returns `config: null` when any piece is missing (agent unbound, no
 * credential, provider not in catalog). The consumer should guard on `config`
 * before attempting to generate text.
 *
 * @example
 * ```tsx
 * const { config, isLoading } = useResolvedModelConfig(spaceId, "writer");
 * const handleGenerate = async () => {
 *   if (!config) return;
 *   const model = createLanguageModel(config);
 *   const { text } = await generateText({ model, prompt: "..." });
 * };
 * ```
 */
export function useResolvedModelConfig(
  spaceId: SpaceId,
  agentName: string,
): {
  config: ResolvedModelConfig | null;
  isLoading: boolean;
  error: Error | null;
} {
  const agents = useAgents(spaceId);
  const credentials = useProviderCredentials(spaceId);
  const catalog = useModelsDevCatalog();

  return useMemo(() => {
    const isLoading =
      agents.isLoading || credentials.isLoading || catalog.isLoading;
    const error = agents.error ?? credentials.error ?? catalog.error;

    const agent = agents.data?.find((a) => a.name === agentName);
    const [providerId, modelId] = parseModelId(agent?.modelId ?? null);

    if (!providerId || !modelId) {
      return { config: null, isLoading, error };
    }

    const credential = credentials.data?.find(
      (c) => c.providerId === providerId,
    );
    const catalogProvider = catalog.data?.providers.find(
      (p) => p.id === providerId,
    );

    if (!credential || !catalogProvider?.npm) {
      return { config: null, isLoading, error };
    }

    return {
      config: {
        npmPackage: catalogProvider.npm,
        modelId,
        apiKey: credential.apiKey,
      },
      isLoading,
      error,
    };
  }, [
    agents.data,
    agents.isLoading,
    agents.error,
    credentials.data,
    credentials.isLoading,
    credentials.error,
    catalog.data,
    catalog.isLoading,
    catalog.error,
    agentName,
  ]);
}
