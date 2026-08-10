import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import {
  useUpdateAgentConfigAutoExecute,
  useUpdateAgentConfigContextCompaction,
  useUpdateAgentConfigModel,
  useUpdateAgentConfigSystemPrompt,
} from "@/hooks";
import { parseModelId } from "@/lib/ai";
import { getRoleBehavior } from "@/lib/ai-roles";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  AgentConfig,
  CatalogProvider,
  ProviderCredential,
} from "@/types";
import { ModelCascadingSelect } from "./model-cascading-select";

/**
 * Preset turn-age thresholds offered in the UI (ADR-0031 §2 — default 3).
 * If the stored `turnAge` ever falls outside this list (e.g. via direct DB
 * edit or a future migration), it is merged in so the current value always
 * remains selectable.
 */
const COMPACT_TURN_AGE_PRESETS = [3, 5, 8, 10] as const;

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
  const autoExecMut = useUpdateAgentConfigAutoExecute(spaceId);
  const compactionMut = useUpdateAgentConfigContextCompaction(spaceId);
  const systemPromptMut = useUpdateAgentConfigSystemPrompt(spaceId);
  const [localPrompt, setLocalPrompt] = useState(agentConfig.systemPrompt);

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

  // Re-sync local prompt state whenever the server-side systemPrompt changes
  // (mutation result, external update, etc.). Keyed on the raw string so a
  // no-op server response doesn't clobber mid-edit.
  useEffect(() => {
    setLocalPrompt(agentConfig.systemPrompt);
  }, [agentConfig.systemPrompt]);

  const availableProviderIds = new Set(credentials.map((c) => c.providerId));

  // Merge the stored turnAge into the preset list so the Select always has
  // a matching item (defensive against non-preset values from the DB).
  const presets: readonly number[] = COMPACT_TURN_AGE_PRESETS;
  const turnAgeOptions: number[] = presets.includes(
    agentConfig.contextCompaction.turnAge,
  )
    ? [...presets]
    : [agentConfig.contextCompaction.turnAge, ...presets];

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

  async function handleAutoExecuteToggle(checked: boolean) {
    try {
      await autoExecMut.mutateAsync({
        id: agentConfig.id,
        autoExecute: checked,
      });
      toast.success(i18n.t("ai:agentConfigs.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  async function handleContextCompactionToggle(checked: boolean) {
    try {
      await compactionMut.mutateAsync({
        id: agentConfig.id,
        contextCompaction: {
          enabled: checked,
          turnAge: agentConfig.contextCompaction.turnAge,
        },
      });
      toast.success(i18n.t("ai:agentConfigs.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  async function handleTurnAgeChange(turnAge: number) {
    try {
      await compactionMut.mutateAsync({
        id: agentConfig.id,
        contextCompaction: {
          enabled: agentConfig.contextCompaction.enabled,
          turnAge,
        },
      });
      toast.success(i18n.t("ai:agentConfigs.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  async function handleSystemPromptBlur() {
    // Only commit if the value actually changed. Prompts are long; committing
    // on every blur would waste round trips when the user clicked away without
    // editing.
    if (localPrompt === agentConfig.systemPrompt) return;
    try {
      await systemPromptMut.mutateAsync({
        id: agentConfig.id,
        systemPrompt: localPrompt,
      });
      toast.success(i18n.t("ai:agentConfigs.systemPrompt.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.systemPrompt.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      // Revert local state on failure so the field reflects the server truth.
      setLocalPrompt(agentConfig.systemPrompt);
    }
  }

  async function handleResetPrompt() {
    setLocalPrompt("");
    try {
      await systemPromptMut.mutateAsync({
        id: agentConfig.id,
        systemPrompt: "",
      });
      toast.success(i18n.t("ai:agentConfigs.systemPrompt.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.systemPrompt.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      // Revert local state on failure — mirror handleSystemPromptBlur.
      setLocalPrompt(agentConfig.systemPrompt);
    }
  }

  return (
    <div className="flex flex-col gap-1">
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
      <div className="flex items-center justify-between gap-6 py-1 pl-1">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("ai:agentConfigs.autoExecute.title")}
          </span>
          <span className="text-[0.6875rem] text-muted-foreground/70">
            {t("ai:agentConfigs.autoExecute.description")}
          </span>
        </div>
        <Switch
          checked={agentConfig.autoExecuteDangerousTools}
          onCheckedChange={handleAutoExecuteToggle}
          disabled={disabled || autoExecMut.isPending}
        />
      </div>
      <div className="flex items-center justify-between gap-6 py-1 pl-1">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium text-muted-foreground">
            {t("ai:agentConfigs.contextCompaction.title")}
          </span>
          <span className="text-[0.6875rem] text-muted-foreground/70">
            {t("ai:agentConfigs.contextCompaction.description")}
          </span>
        </div>
        <Switch
          checked={agentConfig.contextCompaction.enabled}
          onCheckedChange={handleContextCompactionToggle}
          disabled={disabled || compactionMut.isPending}
        />
      </div>
      {agentConfig.contextCompaction.enabled && (
        <div className="flex items-center justify-between gap-6 py-1 pl-1">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t("ai:agentConfigs.contextCompaction.turnAge.title")}
            </span>
            <span className="text-[0.6875rem] text-muted-foreground/70">
              {t("ai:agentConfigs.contextCompaction.turnAge.description")}
            </span>
          </div>
          <Select
            value={String(agentConfig.contextCompaction.turnAge)}
            onValueChange={(val) => {
              if (typeof val === "string") {
                handleTurnAgeChange(Number(val));
              }
            }}
          >
            <SelectTrigger
              className="w-24"
              disabled={disabled || compactionMut.isPending}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectList>
                {turnAgeOptions.map((age) => (
                  <SelectItem key={age} value={String(age)}>
                    <SelectItemText>{String(age)}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            </SelectContent>
          </Select>
        </div>
      )}
      {/* System prompt override */}
      <div className="flex flex-col gap-2 py-2 pl-1">
        <div className="flex items-center justify-between gap-4">
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t("ai:agentConfigs.systemPrompt.title")}
            </span>
            <span className="text-[0.6875rem] text-muted-foreground/70">
              {t("ai:agentConfigs.systemPrompt.description")}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {agentConfig.systemPrompt.trim() ? (
              <span className="text-[0.6875rem] text-muted-foreground/70">
                {t("ai:agentConfigs.systemPrompt.usingCustom")}
              </span>
            ) : (
              <span className="text-[0.6875rem] text-muted-foreground/70">
                {t("ai:agentConfigs.systemPrompt.usingDefault")}
              </span>
            )}
            {agentConfig.systemPrompt.trim() && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 text-xs"
                onClick={handleResetPrompt}
                disabled={disabled || systemPromptMut.isPending}
              >
                {t("ai:agentConfigs.systemPrompt.resetToDefault")}
              </Button>
            )}
          </div>
        </div>
        <Textarea
          value={localPrompt}
          onChange={(e) => setLocalPrompt(e.currentTarget.value)}
          onBlur={handleSystemPromptBlur}
          placeholder={getRoleBehavior(agentConfig.name)?.systemPrompt ?? ""}
          className="min-h-24 text-xs"
          disabled={disabled || systemPromptMut.isPending}
        />
      </div>
    </div>
  );
}
