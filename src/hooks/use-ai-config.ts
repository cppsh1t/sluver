import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  deleteProviderCredential,
  getModelsDevCatalog,
  listAgentConfigs,
  listProviderCredentials,
  refreshModelsDevCatalog,
  setProviderCredential,
  updateAgentConfigModel,
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
export const aiConfigKeys = {
  providers: (spaceId: SpaceId) => ["ai", "providers", spaceId] as const,
  agentConfigs: (spaceId: SpaceId) => ["ai", "agentConfigs", spaceId] as const,
  catalog: () => ["ai", "catalog"] as const,
};

// ─── Provider credentials ───────────────────────────────────────────────────

export const useProviderCredentials = (spaceId: SpaceId) =>
  useQuery({
    queryKey: aiConfigKeys.providers(spaceId),
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
    onSuccess: () => qc.invalidateQueries({ queryKey: aiConfigKeys.providers(spaceId) }),
  });
};

export const useDeleteProviderCredential = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: ProviderCredentialId) =>
      deleteProviderCredential(spaceId, id),
    onSuccess: () => {
      // Deleting a provider cascades server-side: agents bound to that
      // provider's models get their `modelId` cleared, so the agent config
      // cache must be refreshed alongside the provider list.
      qc.invalidateQueries({ queryKey: aiConfigKeys.providers(spaceId) });
      qc.invalidateQueries({ queryKey: aiConfigKeys.agentConfigs(spaceId) });
    },
  });
};

// ─── AgentConfigs ───────────────────────────────────────────────────────────

export const useAgentConfigs = (spaceId: SpaceId) =>
  useQuery({
    queryKey: aiConfigKeys.agentConfigs(spaceId),
    queryFn: () => listAgentConfigs(spaceId),
    enabled: !!spaceId,
  });

export const useUpdateAgentConfigModel = (spaceId: SpaceId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      modelId,
    }: {
      id: string;
      modelId: string | null;
    }) => updateAgentConfigModel(spaceId, id, modelId),
    onSuccess: () => qc.invalidateQueries({ queryKey: aiConfigKeys.agentConfigs(spaceId) }),
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
    queryKey: aiConfigKeys.catalog(),
    queryFn: getModelsDevCatalog,
    staleTime: Number.POSITIVE_INFINITY,
  });

export const useRefreshModelsDevCatalog = () => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshModelsDevCatalog,
    onSuccess: () => qc.invalidateQueries({ queryKey: aiConfigKeys.catalog() }),
  });
};

// ─── Resolved model config (compose agent config + credential + catalog) ────

/**
 * Compose everything needed to call `createLanguageModel()` for a specific
 * agent config, by joining three data sources:
 *
 * 1. **AgentConfig** — its `modelId` (`"anthropic/claude-sonnet-5"`) gives us the
 *    provider id and model id via {@link parseModelId}.
 * 2. **Catalog** — the provider's `npm` field tells us which `@ai-sdk/*`
 *    package to load (e.g. `"@ai-sdk/anthropic"`).
 * 3. **Credential** — the stored `apiKey` for that provider.
 *
 * Returns `config: null` when any piece is missing (agent config unbound, no
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
  agentConfigName: string,
): {
  config: ResolvedModelConfig | null;
  isLoading: boolean;
  error: Error | null;
} {
  const agentConfigs = useAgentConfigs(spaceId);
  const credentials = useProviderCredentials(spaceId);
  const catalog = useModelsDevCatalog();

  return useMemo(() => {
    const isLoading =
      agentConfigs.isLoading || credentials.isLoading || catalog.isLoading;
    const error = agentConfigs.error ?? credentials.error ?? catalog.error;

    const agentConfig = agentConfigs.data?.find((a) => a.name === agentConfigName);
    const [providerId, modelId] = parseModelId(agentConfig?.modelId ?? null);

    if (!providerId || !modelId) {
      return { config: null, isLoading, error };
    }

    const credential = credentials.data?.find(
      (c) => c.providerId === providerId,
    );
    const catalogProvider = catalog.data?.providers.find(
      (p) => p.id === providerId,
    );

    // `apiKey` MUST be a non-empty string — provider packages will accept an
    // empty string at construction but fail with an opaque 401 mid-stream,
    // which surfaces as a generic `status: "error"` with no diagnostic trail.
    // Reject early here so the consumer sees `config: null` instead.
    if (
      !credential ||
      !credential.apiKey ||
      credential.apiKey.trim() === "" ||
      !catalogProvider?.npm
    ) {
      return { config: null, isLoading, error };
    }

    return {
      config: {
        npmPackage: catalogProvider.npm,
        modelId,
        apiKey: credential.apiKey,
        ...(catalogProvider.apiBaseUrl
          ? { baseURL: catalogProvider.apiBaseUrl }
          : {}),
      },
      isLoading,
      error,
    };
  }, [
    agentConfigs.data,
    agentConfigs.isLoading,
    agentConfigs.error,
    credentials.data,
    credentials.isLoading,
    credentials.error,
    catalog.data,
    catalog.isLoading,
    catalog.error,
    agentConfigName,
  ]);
}
