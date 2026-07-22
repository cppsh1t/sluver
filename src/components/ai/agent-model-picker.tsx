import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { useUpdateAgentModel } from "@/hooks";
import type {
  Agent,
  CatalogProvider,
  ProviderCredential,
} from "@/types";
import { ModelCascadingSelect } from "./model-cascading-select";

/**
 * Split a composite `"{providerId}/{modelId}"` modelId into its parts.
 * Returns `[null, null]` when the value is null or doesn't contain a slash,
 * so an unbound or malformed agent renders as "no selection".
 */
function parseModelId(
  modelId: string | null,
): [string | null, string | null] {
  if (!modelId) return [null, null];
  const slash = modelId.indexOf("/");
  if (slash === -1) return [null, null];
  return [modelId.slice(0, slash), modelId.slice(slash + 1)];
}

/**
 * One row per agent: a label (Explorer / Writer) on the left, the cascading
 * provider→model selector on the right.
 *
 * Model changes are committed immediately via `updateAgentModel` — no
 * explicit save button. The mutation invalidates the agent query, so the
 * row reflects the server's response after the round trip.
 */
export function AgentModelPicker({
  spaceId,
  agent,
  providers,
  credentials,
  disabled,
}: {
  spaceId: Parameters<typeof useUpdateAgentModel>[0];
  agent: Agent;
  providers: CatalogProvider[];
  credentials: ProviderCredential[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("ai");
  const updateMut = useUpdateAgentModel(spaceId);

  const [serverProvider, serverModel] = parseModelId(agent.modelId);
  const [localProvider, setLocalProvider] = useState<string | null>(
    serverProvider,
  );
  const [localModel, setLocalModel] = useState<string | null>(serverModel);

  // Re-sync local state whenever the server-side modelId changes (mutation
  // result, cascade clear from provider deletion, etc.). We key on the raw
  // modelId string so a no-op server response doesn't clobber mid-interaction.
  useEffect(() => {
    const [p, m] = parseModelId(agent.modelId);
    setLocalProvider(p);
    setLocalModel(m);
  }, [agent.modelId]);

  const availableProviderIds = new Set(credentials.map((c) => c.providerId));

  async function persistModel(composite: string | null) {
    try {
      await updateMut.mutateAsync({ id: agent.id, modelId: composite });
      toast.success(i18n.t("ai:agents.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agents.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  function handleProviderChange(nextProvider: string | null) {
    setLocalProvider(nextProvider);
    setLocalModel(null);
    // Clear any existing binding when the provider changes — a dangling
    // model from a different provider is never the user's intent.
    if (agent.modelId !== null) {
      persistModel(null);
    }
  }

  function handleModelChange(nextModel: string | null) {
    setLocalModel(nextModel);
    const base = localProvider;
    const composite = base && nextModel ? `${base}/${nextModel}` : null;
    persistModel(composite);
  }

  return (
    <div className="flex items-center justify-between gap-6 py-2.5">
      <span className="text-sm font-medium">
        {t(`ai:agents.name.${agent.name}`, { defaultValue: agent.name })}
      </span>
      <ModelCascadingSelect
        providers={providers}
        availableProviderIds={availableProviderIds}
        selectedProviderId={localProvider}
        selectedModelId={localModel}
        disabled={disabled || updateMut.isPending}
        onProviderChange={handleProviderChange}
        onModelChange={handleModelChange}
      />
    </div>
  );
}
