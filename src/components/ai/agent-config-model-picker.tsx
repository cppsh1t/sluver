import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { useUpdateAgentConfigModel } from "@/hooks";
import { parseModelId } from "@/lib/ai";
import type {
  AgentConfig,
  CatalogProvider,
  ProviderCredential,
} from "@/types";
import { ModelCascadingSelect } from "./model-cascading-select";

/**
 * One row per agent config: a label (Explorer / Writer) on the left, the
 * cascading provider→model selector on the right.
 *
 * Model changes are committed immediately via `updateAgentConfigModel` — no
 * explicit save button. The mutation invalidates the agent config query, so
 * the row reflects the server's response after the round trip.
 */
export function AgentConfigModelPicker({
  spaceId,
  agentConfig,
  providers,
  credentials,
  disabled,
}: {
  spaceId: Parameters<typeof useUpdateAgentConfigModel>[0];
  agentConfig: AgentConfig;
  providers: CatalogProvider[];
  credentials: ProviderCredential[];
  disabled?: boolean;
}) {
  const { t } = useTranslation("ai");
  const updateMut = useUpdateAgentConfigModel(spaceId);

  const [serverProvider, serverModel] = parseModelId(agentConfig.modelId);
  const [localProvider, setLocalProvider] = useState<string | null>(
    serverProvider,
  );
  const [localModel, setLocalModel] = useState<string | null>(serverModel);

  // Track the last modelId we persisted ourselves. The useEffect below
  // syncs local state when `agentConfig.modelId` changes externally (e.g.
  // provider deletion cascade). But when WE triggered the change (via
  // persistModel), the server echo would clobber the user's in-progress
  // selection — e.g. they pick "openai", we persist null, server returns
  // null, and the effect would reset the provider dropdown. This ref lets
  // the effect skip its own echo: if the incoming value matches what we
  // just sent, consume the ref and bail.
  const lastPersistedRef = useRef<string | null | undefined>(undefined);

  // Re-sync local state whenever the server-side modelId changes (mutation
  // result, cascade clear from provider deletion, etc.). We key on the raw
  // modelId string so a no-op server response doesn't clobber mid-interaction.
  useEffect(() => {
    if (agentConfig.modelId === lastPersistedRef.current) {
      lastPersistedRef.current = undefined;
      return;
    }
    const [p, m] = parseModelId(agentConfig.modelId);
    setLocalProvider(p);
    setLocalModel(m);
  }, [agentConfig.modelId]);

  const availableProviderIds = new Set(credentials.map((c) => c.providerId));

  async function persistModel(composite: string | null) {
    lastPersistedRef.current = composite;
    try {
      await updateMut.mutateAsync({ id: agentConfig.id, modelId: composite });
      toast.success(i18n.t("ai:agentConfigs.toast.updateSuccess"));
    } catch (err) {
      lastPersistedRef.current = undefined;
      toast.error(i18n.t("ai:agentConfigs.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  function handleProviderChange(nextProvider: string | null) {
    setLocalProvider(nextProvider);
    setLocalModel(null);
    // Clear any existing binding when the provider changes — a dangling
    // model from a different provider is never the user's intent.
    if (agentConfig.modelId !== null) {
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
        {t(`ai:agentConfigs.name.${agentConfig.name}`, { defaultValue: agentConfig.name })}
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
