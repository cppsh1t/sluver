import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Settings02Icon } from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import {
  useEnabledSkills,
  useSetSkillEnabled,
  useSkills,
  useUpdateAgentConfigAutoExecute,
  useUpdateAgentConfigContextCompaction,
  useUpdateAgentConfigModel,
  useUpdateAgentConfigShellTool,
  useUpdateAgentConfigSystemPrompt,
} from "@/hooks";
import { parseModelId } from "@/lib/ai";
import { getRoleBehavior } from "@/lib/ai-roles";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
  SkillId,
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
 * One row per agent config: a label (Explorer / Writer) on the left, a brief
 * model summary in the middle, and a config (gear) icon button on the right
 * that opens a dialog hosting the full set of per-agent settings — model,
 * auto-execute, shell tool, context compaction, skills, and system prompt
 * override.
 *
 * All settings still commit immediately on change (no explicit save button);
 * the mutations invalidate the agent config query, so the row + dialog reflect
 * the server's response after each round trip.
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
  const { t } = useTranslation(["ai", "skills"]);
  const updateMut = useUpdateAgentConfigModel(spaceId);
  const autoExecMut = useUpdateAgentConfigAutoExecute(spaceId);
  const shellMut = useUpdateAgentConfigShellTool(spaceId);
  const compactionMut = useUpdateAgentConfigContextCompaction(spaceId);
  const systemPromptMut = useUpdateAgentConfigSystemPrompt(spaceId);
  const skillsQ = useSkills(spaceId);
  const skillMut = useSetSkillEnabled(spaceId);
  const [localPrompt, setLocalPrompt] = useState(agentConfig.systemPrompt);

  // ADR-0040 — the "namer" agent drives a single one-shot naming call;
  // the "vision" agent likewise backs a single one-shot image-description
  // call (the look_at tool). Tool execution / context compaction / system
  // prompt override are meaningless for such one-shot roles, so their
  // dialogs show the model binding only. Explorer/writer cards are
  // unaffected (byte-identical rendering).
  const isOneShot =
    agentConfig.name === "namer" || agentConfig.name === "vision";

  // ADR-0042 — the shell tool is registered on the explorer and writer
  // roles (each gated by that role's `shellToolEnabled` flag), so its
  // toggle is hidden for the namer config only.
  const canUseShellTool =
    agentConfig.name === "explorer" || agentConfig.name === "writer";

  // ADR-0043 — skill enablement per AgentConfig. The enabled set comes
  // from the agent's INSTALLED (on-disk) copies — the runtime truth — so
  // the Switch reflects exactly what a new conversation would load. The
  // one-shot roles never receive skills, so their query stays dormant.
  const enabledSkillsQ = useEnabledSkills(spaceId, agentConfig.name, !isOneShot);
  const enabledSkillIds = useMemo(
    () => new Set<SkillId>((enabledSkillsQ.data ?? []).map((s) => s.id)),
    [enabledSkillsQ.data],
  );

  // Confirm-on-enable gate for the shell tool (ADR-0042). Only the dialog's
  // open state is local; the Switch itself stays controlled by
  // agentConfig.shellToolEnabled, so cancelling leaves it off for free.
  const [shellConfirmOpen, setShellConfirmOpen] = useState(false);

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

  // Enabling the shell tool is a risk-acknowledged decision (ADR-0042): the
  // agent reads world text that could carry prompt injections, so turning it
  // ON must pass through the confirmation AlertDialog before committing.
  // Turning it OFF is always safe and commits immediately, no dialog.
  function handleShellToolToggle(checked: boolean) {
    if (checked) {
      setShellConfirmOpen(true);
      return;
    }
    void commitShellTool(false);
  }

  async function commitShellTool(shellToolEnabled: boolean) {
    try {
      await shellMut.mutateAsync({
        id: agentConfig.id,
        shellToolEnabled,
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

  // ADR-0043 §2 — enabling installs the skill's zip to disk, disabling
  // removes the directory. Takes effect for new conversations (same
  // lifecycle as model/shell/compaction, per the ADR-0024 agent cache).
  async function handleSkillToggle(skillId: SkillId, enabled: boolean) {
    try {
      await skillMut.mutateAsync({
        agentConfigId: agentConfig.id,
        skillId,
        enabled,
      });
      toast.success(i18n.t("skills:dialog.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("skills:dialog.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  async function commitPromptIfDirty() {
    // Only commit if the value actually changed. Prompts are long; committing
    // on every blur would waste round trips when the user clicked away without
    // editing. This is also called from the Dialog's onOpenChange when the
    // dialog closes — close paths (ESC / X / backdrop) aren't guaranteed to
    // fire the textarea's onBlur before the content unmounts, so an explicit
    // close-time commit is the safety net that prevents silent data loss.
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

  // Resolve human-readable provider/model names for the compact row summary.
  // Falls back to raw ids if the catalog entry is missing (e.g. provider was
  // removed but the binding lingered), and to a localized "none" hint when
  // no model is bound at all. Reuses the serverProvider/serverModel parse
  // from the initial-state block above.
  const summary = useMemo(() => {
    if (!serverProvider || !serverModel) return null;
    const provider = providers.find((p) => p.id === serverProvider);
    const providerName = provider?.name ?? serverProvider;
    const modelName =
      provider?.models.find((m) => m.id === serverModel)?.name ?? serverModel;
    return `${providerName} · ${modelName}`;
  }, [providers, serverProvider, serverModel]);

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        // Commit an in-progress system-prompt edit when the dialog closes —
        // see commitPromptIfDirty for why this is needed in addition to blur.
        if (!nextOpen) void commitPromptIfDirty();
      }}
    >
      {/* Compact row: name + model summary + config (gear) icon button.
          The whole row is a direct child of the section's divide-y list. */}
      <div className="flex items-center justify-between gap-4 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {t(`ai:agentConfigs.name.${agentConfig.name}`, { defaultValue: agentConfig.name })}
          </span>
          {summary ? (
            <span className="truncate text-xs text-muted-foreground/70">
              {summary}
            </span>
          ) : (
            <span className="truncate text-xs italic text-muted-foreground/60">
              {t("ai:agentConfigs.modelNone")}
            </span>
          )}
        </div>
        <DialogTrigger
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              disabled={disabled}
              aria-label={t("ai:agentConfigs.configure")}
            />
          }
        >
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
        </DialogTrigger>
      </div>

      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader className="shrink-0">
          <DialogTitle>
            {t(`ai:agentConfigs.name.${agentConfig.name}`, { defaultValue: agentConfig.name })}
          </DialogTitle>
          <DialogDescription>
            {isOneShot
              ? t(`ai:agentConfigs.roleDescription.${agentConfig.name}`, {
                  defaultValue: "",
                })
              : t("ai:agentConfigs.dialog.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-x-hidden overflow-y-auto">
          {/* Model binding */}
          <div className="flex flex-col gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              {t("ai:agentConfigs.modelLabel")}
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

          {/* Auto-execute — one-shot roles run no tools (ADR-0040), so hidden for them */}
          {!isOneShot && (
          <div className="flex items-center justify-between gap-6">
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
          )}

          {/* Shell tool — explorer/writer configs (ADR-0042). Enabling is
              gated behind a risk-acknowledgement AlertDialog; disabling
              commits immediately. */}
          {canUseShellTool && (
            <>
              <div className="flex items-center justify-between gap-6">
                <div className="flex flex-col gap-0.5">
                  <span className="text-xs font-medium text-muted-foreground">
                    {t("ai:agentConfigs.shellTool.title")}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground/70">
                    {t("ai:agentConfigs.shellTool.description")}
                  </span>
                </div>
                <Switch
                  checked={agentConfig.shellToolEnabled}
                  onCheckedChange={handleShellToolToggle}
                  disabled={disabled || shellMut.isPending}
                />
              </div>
              <AlertDialog
                open={shellConfirmOpen}
                onOpenChange={(open) => setShellConfirmOpen(open)}
              >
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      {t("ai:agentConfigs.shellTool.warning.title")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      {t("ai:agentConfigs.shellTool.warning.body")}
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>
                      {t("ai:agentConfigs.shellTool.warning.cancel")}
                    </AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={shellMut.isPending}
                      onClick={() => {
                        setShellConfirmOpen(false);
                        void commitShellTool(true);
                      }}
                    >
                      {t("ai:agentConfigs.shellTool.warning.confirm")}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </>
          )}

          {/* Context compaction — meaningless for a one-shot call */}
          {!isOneShot && (
          <div className="flex items-center justify-between gap-6">
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
          )}
          {!isOneShot && agentConfig.contextCompaction.enabled && (
            <div className="flex items-center justify-between gap-6">
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

          {/* Skills — per-AgentConfig enablement (ADR-0043). The catalog is
              injected for explorer/writer only (never one-shot roles), so
              the whole section mirrors the shell-tool visibility gate. */}
          {!isOneShot && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("skills:dialog.title")}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground/70">
                {t("skills:dialog.description")}
              </span>
            </div>
            {skillsQ.isLoading ? (
              <p className="text-xs text-muted-foreground">
                {t("skills:dialog.loading")}
              </p>
            ) : skillsQ.isError ? (
              <p className="text-xs text-destructive">
                {t("skills:dialog.loadFailed")}
              </p>
            ) : (skillsQ.data ?? []).length === 0 ? (
              <p className="text-xs italic text-muted-foreground/70">
                {t("skills:dialog.empty")}
              </p>
            ) : (
              <div className="flex flex-col divide-y divide-border rounded-md border border-border">
                {(skillsQ.data ?? []).map((skill) => (
                  <div
                    key={skill.id}
                    className="flex items-start justify-between gap-4 px-3 py-2.5"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      {/* `name` is a lowercase-hyphen slug — code font. */}
                      <span className="truncate font-mono text-xs font-medium">
                        {skill.name}
                      </span>
                      <span className="line-clamp-2 text-[0.6875rem] text-muted-foreground/70">
                        {skill.description}
                      </span>
                    </div>
                    <Switch
                      checked={enabledSkillIds.has(skill.id)}
                      onCheckedChange={(checked) =>
                        void handleSkillToggle(skill.id, checked)
                      }
                      disabled={disabled || skillMut.isPending}
                    />
                  </div>
                ))}
              </div>
            )}
            <p className="text-[0.6875rem] text-muted-foreground/70">
              {t("skills:dialog.note")}
            </p>
          </div>
          )}

          {/* System prompt override — one-shot roles' prompts are fixed in
              code (namer: src/lib/ai/auto-title.ts), so the editor is
              hidden for them */}
          {!isOneShot && (
          <div className="flex flex-col gap-2">
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
              onBlur={commitPromptIfDirty}
              placeholder={getRoleBehavior(agentConfig.name)?.systemPrompt ?? ""}
              className="min-h-24 text-xs"
              disabled={disabled || systemPromptMut.isPending}
            />
          </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
