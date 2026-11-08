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
  useUpdateAgentConfigContextNote,
  useUpdateAgentConfigMaxSteps,
  useUpdateAgentConfigModel,
  useUpdateAgentConfigModelSettings,
  useUpdateAgentConfigShellTool,
} from "@/hooks";
import { parseModelId } from "@/lib/ai";
import { getRoleDefinition } from "@/lib/ai-roles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  ModelSettings,
  ProviderCredential,
  ReasoningEffort,
  SkillId,
} from "@/types";
import { REASONING_EFFORTS } from "@/types";
import { ModelCascadingSelect } from "./model-cascading-select";

/**
 * Preset turn-age thresholds offered in the UI (ADR-0031 §2 — default 3).
 * If the stored `turnAge` ever falls outside this list (e.g. via direct DB
 * edit or a future migration), it is merged in so the current value always
 * remains selectable.
 */
const COMPACT_TURN_AGE_PRESETS = [3, 5, 8, 10] as const;

/**
 * Preset max-steps caps offered in the UI (built-in loop default is 30).
 * If the stored `maxSteps` ever falls outside this list (e.g. via direct
 * DB edit or a future migration), it is merged in so the current value
 * always remains selectable.
 */
const MAX_STEPS_PRESETS = [10, 15, 20, 30, 40, 50, 80, 100, 150, 200] as const;

/**
 * Sentinel Select value for the "Default" max-steps option. Select values
 * are strings, so the null default (built-in 30) maps to this sentinel.
 */
const MAX_STEPS_DEFAULT_VALUE = "default";

/**
 * Sentinel Select value for the "Default" reasoning-effort option — the
 * null default (provider decides) maps to this sentinel, same pattern
 * as MAX_STEPS_DEFAULT_VALUE above.
 */
const REASONING_DEFAULT_VALUE = "default";

/**
 * Numeric model-parameter fields with their validation rules. Each rule
 * mirrors the corresponding bound in modelSettingsSchema so an invalid
 * draft (NaN / out of range) reverts locally on blur instead of bouncing
 * off the server.
 */
const NUMERIC_FIELD_RULES = {
  temperature: { min: 0, max: 2, integer: false },
  topP: { min: 0, max: 1, integer: false },
  topK: { min: 1, max: Number.POSITIVE_INFINITY, integer: true },
  maxOutputTokens: { min: 1, max: Number.POSITIVE_INFINITY, integer: true },
} as const;

type NumericModelField = keyof typeof NUMERIC_FIELD_RULES;

/** Format a nullable numeric setting for its draft input ("" = default). */
function numToDraft(value: number | null): string {
  return value === null ? "" : String(value);
}

/** Pretty-print nullable providerOptions for the JSON textarea ("" = unset). */
function prettyProviderOptions(
  value: Record<string, unknown> | null,
): string {
  return value === null ? "" : JSON.stringify(value, null, 2);
}

/**
 * Parse a numeric model-parameter draft. Returns undefined for invalid
 * input (NaN / out of range), null for "back to provider default" (the
 * empty string), or the parsed number.
 */
function parseNumericDraft(
  field: NumericModelField,
  raw: string,
): number | null | undefined {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  const num = Number(trimmed);
  const rule = NUMERIC_FIELD_RULES[field];
  const valid =
    Number.isFinite(num) &&
    num >= rule.min &&
    num <= rule.max &&
    (!rule.integer || Number.isInteger(num));
  return valid ? num : undefined;
}

/**
 * Parse a providerOptions draft. Returns undefined when the text is not
 * valid JSON or not a JSON object — the schema wants a record, never a
 * scalar/array/null literal.
 */
function parseProviderOptions(
  trimmed: string,
): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/**
 * Compose the next whole-blob ModelSettings with one numeric field
 * overridden. Explicit per-field cases (not a computed key) keep the
 * result precisely typed.
 */
function composeNumericSettings(
  base: ModelSettings,
  field: NumericModelField,
  value: number | null,
): ModelSettings {
  switch (field) {
    case "temperature":
      return { ...base, temperature: value };
    case "topP":
      return { ...base, topP: value };
    case "topK":
      return { ...base, topK: value };
    case "maxOutputTokens":
      return { ...base, maxOutputTokens: value };
  }
}

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
  const maxStepsMut = useUpdateAgentConfigMaxSteps(spaceId);
  const contextNoteMut = useUpdateAgentConfigContextNote(spaceId);
  const modelSettingsMut = useUpdateAgentConfigModelSettings(spaceId);
  const skillsQ = useSkills(spaceId);
  const skillMut = useSetSkillEnabled(spaceId);
  const [localNote, setLocalNote] = useState(agentConfig.contextNote);

  // Model parameters (ADR-0056) — local drafts follow the localNote
  // precedent: controlled inputs over draft state, committed on blur
  // (Enter too, for the numeric fields), re-synced from the server
  // whenever the persisted values change.
  const [numericDrafts, setNumericDrafts] = useState<
    Record<NumericModelField, string>
  >({
    temperature: numToDraft(agentConfig.modelSettings.temperature),
    topP: numToDraft(agentConfig.modelSettings.topP),
    topK: numToDraft(agentConfig.modelSettings.topK),
    maxOutputTokens: numToDraft(agentConfig.modelSettings.maxOutputTokens),
  });
  const [localProviderOptions, setLocalProviderOptions] = useState(() =>
    prettyProviderOptions(agentConfig.modelSettings.providerOptions),
  );
  const [providerOptionsInvalid, setProviderOptionsInvalid] = useState(false);

  function setNumericDraft(field: NumericModelField, value: string) {
    setNumericDrafts((drafts) => {
      const next: Record<NumericModelField, string> = { ...drafts };
      next[field] = value;
      return next;
    });
  }

  // Registry-driven role shape (ADR-0050 D1): every flag below reads the
  // role's registry entry instead of hardcoded name lists, so new roles
  // seeded by the registry inherit the right card behavior for free.
  const roleDef = getRoleDefinition(agentConfig.name);

  // One-line duty statement under the config name (ADR-0050 D7): localized
  // via `roleDescription.<name>`, falling back to the registry's model-
  // facing `duty` string so a missing translation never blanks the line.
  const dutyLine = t(`ai:agentConfigs.roleDescription.${agentConfig.name}`, {
    defaultValue: roleDef?.duty ?? "",
  });

  // ADR-0040/0045 — the "namer" and "vision" agents drive single one-shot
  // calls (auto-titling / look_at). Tool execution / context compaction /
  // system prompt override are meaningless for such roles, so their
  // dialogs show the model binding only.
  const isOneShot = roleDef?.kind === "oneshot";

  // ADR-0045 — the vision role's model dropdown filters to image-capable
  // (or unknown-capability) models; tri-state semantics live in
  // ModelCascadingSelect's isImageSelectable. The namer does text-only
  // work, so it keeps the unfiltered list.
  const isVision = agentConfig.name === "vision";

  // ADR-0042/0050 — the shell tool is part of every loop role's universal
  // set (conversational + subagents), each gated by that role's own
  // `shellToolEnabled` flag; one-shot roles never carry it.
  const canUseShellTool =
    roleDef?.kind === "conversational" || roleDef?.kind === "subagent";

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

  // Re-sync local note state whenever the server-side contextNote changes
  // (mutation result, external update, etc.). Keyed on the raw string so a
  // no-op server response doesn't clobber mid-edit.
  useEffect(() => {
    setLocalNote(agentConfig.contextNote);
  }, [agentConfig.contextNote]);

  // Re-sync local model-parameter drafts whenever the server-side values
  // change (mutation echo, external update). Per-field effects (like the
  // contextNote one above) keep one field's commit from clobbering a
  // sibling draft the user is still editing.
  useEffect(() => {
    setNumericDrafts((drafts) => ({
      ...drafts,
      temperature: numToDraft(agentConfig.modelSettings.temperature),
    }));
  }, [agentConfig.modelSettings.temperature]);
  useEffect(() => {
    setNumericDrafts((drafts) => ({
      ...drafts,
      topP: numToDraft(agentConfig.modelSettings.topP),
    }));
  }, [agentConfig.modelSettings.topP]);
  useEffect(() => {
    setNumericDrafts((drafts) => ({
      ...drafts,
      topK: numToDraft(agentConfig.modelSettings.topK),
    }));
  }, [agentConfig.modelSettings.topK]);
  useEffect(() => {
    setNumericDrafts((drafts) => ({
      ...drafts,
      maxOutputTokens: numToDraft(agentConfig.modelSettings.maxOutputTokens),
    }));
  }, [agentConfig.modelSettings.maxOutputTokens]);
  useEffect(() => {
    setLocalProviderOptions(
      prettyProviderOptions(agentConfig.modelSettings.providerOptions),
    );
  }, [agentConfig.modelSettings.providerOptions]);

  const availableProviderIds = new Set(credentials.map((c) => c.providerId));

  // Merge the stored turnAge into the preset list so the Select always has
  // a matching item (defensive against non-preset values from the DB).
  const presets: readonly number[] = COMPACT_TURN_AGE_PRESETS;
  const turnAgeOptions: number[] = presets.includes(
    agentConfig.contextCompaction.turnAge,
  )
    ? [...presets]
    : [agentConfig.contextCompaction.turnAge, ...presets];

  // Merge the stored maxSteps into the preset list so the Select always has
  // a matching item (defensive against non-preset values from the DB). The
  // null default maps to the sentinel option instead of a numeric entry.
  const maxStepsPresets: readonly number[] = MAX_STEPS_PRESETS;
  const maxStepsOptions: number[] =
    agentConfig.maxSteps !== null &&
    !maxStepsPresets.includes(agentConfig.maxSteps)
      ? [agentConfig.maxSteps, ...maxStepsPresets]
      : [...maxStepsPresets];

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

  async function handleMaxStepsChange(maxSteps: number | null) {
    try {
      await maxStepsMut.mutateAsync({
        id: agentConfig.id,
        maxSteps,
      });
      toast.success(i18n.t("ai:agentConfigs.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  // Model parameters (ADR-0056) — whole-blob commit through the frozen
  // seam: every field change composes {...modelSettings, field: value}
  // and round-trips the full object. `revert` (optional) restores local
  // draft state when the server rejects the write so the UI keeps
  // reflecting server truth.
  async function persistModelSettings(
    next: ModelSettings,
    revert?: () => void,
  ) {
    try {
      await modelSettingsMut.mutateAsync({
        id: agentConfig.id,
        modelSettings: next,
      });
      toast.success(i18n.t("ai:agentConfigs.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      revert?.();
    }
  }

  function handleReasoningChange(reasoning: ReasoningEffort | null) {
    if (reasoning === agentConfig.modelSettings.reasoning) return;
    // The Select is controlled straight off agentConfig — on failure the
    // query is not invalidated, so the trigger falls back to server truth.
    void persistModelSettings({ ...agentConfig.modelSettings, reasoning });
  }

  function commitNumericField(field: NumericModelField, raw: string) {
    const persisted = agentConfig.modelSettings[field];
    const parsed = parseNumericDraft(field, raw);
    // Invalid drafts (NaN / out of range) and no-op values both revert
    // the display to the persisted value — no commit, no toast spam.
    if (parsed === undefined || parsed === persisted) {
      setNumericDraft(field, numToDraft(persisted));
      return;
    }
    void persistModelSettings(
      composeNumericSettings(agentConfig.modelSettings, field, parsed),
      () => setNumericDraft(field, numToDraft(persisted)),
    );
  }

  function commitProviderOptions(raw: string) {
    const persisted = agentConfig.modelSettings.providerOptions;
    const trimmed = raw.trim();
    // Empty input = unset (null).
    if (trimmed === "") {
      setProviderOptionsInvalid(false);
      if (persisted !== null) {
        void persistModelSettings(
          { ...agentConfig.modelSettings, providerOptions: null },
          () => setLocalProviderOptions(prettyProviderOptions(persisted)),
        );
      }
      return;
    }
    const record = parseProviderOptions(trimmed);
    if (record === undefined) {
      // Invalid JSON: keep the draft so the user can fix it; flag the
      // inline hint instead of committing or toasting.
      setProviderOptionsInvalid(true);
      return;
    }
    setProviderOptionsInvalid(false);
    if (JSON.stringify(record) === JSON.stringify(persisted)) {
      // Same value typed differently (e.g. re-formatted): normalize the
      // display, skip the round trip.
      setLocalProviderOptions(prettyProviderOptions(persisted));
      return;
    }
    void persistModelSettings(
      { ...agentConfig.modelSettings, providerOptions: record },
      () => setLocalProviderOptions(prettyProviderOptions(persisted)),
    );
  }

  function resetModelParamsDrafts() {
    setNumericDrafts({
      temperature: numToDraft(agentConfig.modelSettings.temperature),
      topP: numToDraft(agentConfig.modelSettings.topP),
      topK: numToDraft(agentConfig.modelSettings.topK),
      maxOutputTokens: numToDraft(agentConfig.modelSettings.maxOutputTokens),
    });
    setLocalProviderOptions(
      prettyProviderOptions(agentConfig.modelSettings.providerOptions),
    );
  }

  // Close-time flush for the model-parameter drafts — same safety net as
  // commitNoteIfDirty: close paths (ESC / X / backdrop) aren't guaranteed
  // to fire blur before the content unmounts. All dirty fields coalesce
  // into ONE whole-blob commit; per-field mutations here would race (each
  // composes from the same pre-commit snapshot, last-write-wins).
  function flushModelParamsOnClose() {
    let next = agentConfig.modelSettings;
    let dirty = false;
    for (const field of Object.keys(
      NUMERIC_FIELD_RULES,
    ) as NumericModelField[]) {
      const persisted = agentConfig.modelSettings[field];
      const parsed = parseNumericDraft(field, numericDrafts[field]);
      if (parsed === undefined) {
        setNumericDraft(field, numToDraft(persisted));
        continue;
      }
      if (parsed !== persisted) {
        next = composeNumericSettings(next, field, parsed);
        dirty = true;
      }
    }
    const persistedOpts = agentConfig.modelSettings.providerOptions;
    const trimmed = localProviderOptions.trim();
    if (trimmed === "") {
      if (persistedOpts !== null) {
        next = { ...next, providerOptions: null };
        dirty = true;
      }
    } else {
      const record = parseProviderOptions(trimmed);
      if (record === undefined) {
        // Keep the draft + flag so it's visible the next time the dialog
        // opens and the user can fix it there.
        setProviderOptionsInvalid(true);
      } else if (
        JSON.stringify(record) !== JSON.stringify(persistedOpts)
      ) {
        next = { ...next, providerOptions: record };
        dirty = true;
      }
    }
    if (dirty) {
      void persistModelSettings(next, resetModelParamsDrafts);
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

  async function commitNoteIfDirty() {
    // Only commit if the value actually changed. Committing on every blur
    // would waste round trips when the user clicked away without editing.
    // This is also called from the Dialog's onOpenChange when the dialog
    // closes — close paths (ESC / X / backdrop) aren't guaranteed to fire
    // the textarea's onBlur before the content unmounts, so an explicit
    // close-time commit is the safety net that prevents silent data loss.
    if (localNote === agentConfig.contextNote) return;
    try {
      await contextNoteMut.mutateAsync({
        id: agentConfig.id,
        contextNote: localNote,
      });
      toast.success(i18n.t("ai:agentConfigs.contextNote.toast.updateSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:agentConfigs.contextNote.toast.updateFailed"), {
        description: translateError(toErrorPayload(err)),
      });
      // Revert local state on failure so the field reflects the server truth.
      setLocalNote(agentConfig.contextNote);
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
        // Commit in-progress drafts (context note, model parameters) when
        // the dialog closes — see commitNoteIfDirty for why blur alone
        // isn't enough (close paths can unmount before onBlur fires).
        if (!nextOpen) {
          void commitNoteIfDirty();
          flushModelParamsOnClose();
        }
      }}
    >
      {/* Compact row: name + model summary + config (gear) icon button.
          The whole row is a direct child of the section's divide-y list. */}
      <div className="flex items-center justify-between gap-4 py-2.5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium">
            {agentConfig.name}
          </span>
          {dutyLine && (
            <span className="truncate text-xs text-muted-foreground/70">
              {dutyLine}
            </span>
          )}
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
            {agentConfig.name}
          </DialogTitle>
          <DialogDescription>
            {/* Duty line for every role (ADR-0050 D7); the generic
                description survives only as the fallback for configs the
                registry doesn't know (e.g. legacy DB rows). */}
            {dutyLine || t("ai:agentConfigs.dialog.description")}
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
              requireImageInput={isVision}
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

          {/* Max steps — the agent loop's hard iteration cap. Null keeps
              the built-in default (30). One-shot roles never run the loop,
              so the section is hidden for them (same gate as compaction). */}
          {!isOneShot && (
          <div className="flex items-center justify-between gap-6">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("ai:agentConfigs.maxSteps.title")}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground/70">
                {t("ai:agentConfigs.maxSteps.description")}
              </span>
            </div>
            <Select
              value={
                agentConfig.maxSteps === null
                  ? MAX_STEPS_DEFAULT_VALUE
                  : String(agentConfig.maxSteps)
              }
              onValueChange={(val) => {
                if (typeof val === "string") {
                  handleMaxStepsChange(
                    val === MAX_STEPS_DEFAULT_VALUE ? null : Number(val),
                  );
                }
              }}
            >
              {/* Wider than turnAge's w-24: the localized Default label is
                  longer than a bare number and the trigger is
                  whitespace-nowrap. */}
              <SelectTrigger
                className="w-40"
                disabled={disabled || maxStepsMut.isPending}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectList>
                  <SelectItem value={MAX_STEPS_DEFAULT_VALUE}>
                    <SelectItemText>
                      {t("ai:agentConfigs.maxSteps.defaultOption")}
                    </SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                  {maxStepsOptions.map((steps) => (
                    <SelectItem key={steps} value={String(steps)}>
                      <SelectItemText>{String(steps)}</SelectItemText>
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
                      <div className="flex min-w-0 items-baseline gap-1.5">
                        {/* `name` is a lowercase-hyphen slug — code font. */}
                        <span className="truncate font-mono text-xs font-medium">
                          {skill.name}
                        </span>
                        {/* Official skills (ADR-0055) are default-enabled
                            on designated roles; the badge marks which
                            switches came pre-set by the app. Toggling is
                            still free — default-on is not locked-on. */}
                        {skill.kind === "official" && (
                          <span className="shrink-0 rounded-sm border border-border px-1 py-px text-[0.625rem] leading-none text-muted-foreground">
                            {t("skills:officialBadge")}
                          </span>
                        )}
                      </div>
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

          {/* Context note — the user's custom guideline, inserted at the
              end of this role's <context> block at Agent construction
              (injectContextNote). One-shot roles' prompts are fixed in
              code (namer: src/lib/ai/auto-title.ts), so the editor is
              hidden for them. Clearing the field commits "" = no note. */}
          {!isOneShot && (
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("ai:agentConfigs.contextNote.title")}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground/70">
                {t("ai:agentConfigs.contextNote.description")}
              </span>
            </div>
            <Textarea
              value={localNote}
              onChange={(e) => setLocalNote(e.currentTarget.value)}
              onBlur={commitNoteIfDirty}
              placeholder={t("ai:agentConfigs.contextNote.placeholder")}
              className="min-h-24 text-xs"
              disabled={disabled || contextNoteMut.isPending}
            />
          </div>
          )}

          {/* Model parameters — per-role generation overrides (ADR-0056).
              Applies to EVERY role: one-shot namer/vision calls take the
              same parameters as loop roles, so the section is not gated
              on !isOneShot. Every field commits the whole modelSettings
              blob; null / empty / "default" = provider default. */}
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">
                {t("ai:agentConfigs.modelParams.sectionTitle")}
              </span>
              <span className="text-[0.6875rem] text-muted-foreground/70">
                {t("ai:agentConfigs.modelParams.sectionDescription")}
              </span>
            </div>

            {/* Numeric rows share one interaction model: local draft,
                commit on blur (Enter blurs), empty = default, invalid
                input reverts to the persisted value on blur. */}
            <div className="flex items-center justify-between gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("ai:agentConfigs.modelParams.temperature.title")}
                </span>
                <span className="text-[0.6875rem] text-muted-foreground/70">
                  {t("ai:agentConfigs.modelParams.temperature.description")}
                </span>
              </div>
              <Input
                type="number"
                className="w-24"
                min={0}
                max={2}
                step={0.1}
                placeholder={t("ai:agentConfigs.modelParams.defaultPlaceholder")}
                value={numericDrafts.temperature}
                disabled={disabled || modelSettingsMut.isPending}
                onChange={(e) =>
                  setNumericDraft("temperature", e.currentTarget.value)
                }
                onBlur={(e) =>
                  commitNumericField("temperature", e.currentTarget.value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("ai:agentConfigs.modelParams.topP.title")}
                </span>
                <span className="text-[0.6875rem] text-muted-foreground/70">
                  {t("ai:agentConfigs.modelParams.topP.description")}
                </span>
              </div>
              <Input
                type="number"
                className="w-24"
                min={0}
                max={1}
                step={0.05}
                placeholder={t("ai:agentConfigs.modelParams.defaultPlaceholder")}
                value={numericDrafts.topP}
                disabled={disabled || modelSettingsMut.isPending}
                onChange={(e) => setNumericDraft("topP", e.currentTarget.value)}
                onBlur={(e) => commitNumericField("topP", e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("ai:agentConfigs.modelParams.topK.title")}
                </span>
                <span className="text-[0.6875rem] text-muted-foreground/70">
                  {t("ai:agentConfigs.modelParams.topK.description")}
                </span>
              </div>
              <Input
                type="number"
                className="w-24"
                min={1}
                step={1}
                placeholder={t("ai:agentConfigs.modelParams.defaultPlaceholder")}
                value={numericDrafts.topK}
                disabled={disabled || modelSettingsMut.isPending}
                onChange={(e) => setNumericDraft("topK", e.currentTarget.value)}
                onBlur={(e) => commitNumericField("topK", e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>

            <div className="flex items-center justify-between gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("ai:agentConfigs.modelParams.maxOutputTokens.title")}
                </span>
                <span className="text-[0.6875rem] text-muted-foreground/70">
                  {t("ai:agentConfigs.modelParams.maxOutputTokens.description")}
                </span>
              </div>
              {/* Wider than the other numeric rows: token caps run into
                  five or six digits. */}
              <Input
                type="number"
                className="w-28"
                min={1}
                step={1}
                placeholder={t("ai:agentConfigs.modelParams.defaultPlaceholder")}
                value={numericDrafts.maxOutputTokens}
                disabled={disabled || modelSettingsMut.isPending}
                onChange={(e) =>
                  setNumericDraft("maxOutputTokens", e.currentTarget.value)
                }
                onBlur={(e) =>
                  commitNumericField("maxOutputTokens", e.currentTarget.value)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
              />
            </div>

            {/* Reasoning effort — same sentinel-Select pattern as the
                max-steps row above ("default" maps to null). */}
            <div className="flex items-center justify-between gap-6">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("ai:agentConfigs.modelParams.reasoning.title")}
                </span>
                <span className="text-[0.6875rem] text-muted-foreground/70">
                  {t("ai:agentConfigs.modelParams.reasoning.description")}
                </span>
              </div>
              <Select
                value={
                  agentConfig.modelSettings.reasoning ?? REASONING_DEFAULT_VALUE
                }
                onValueChange={(val) => {
                  if (typeof val === "string") {
                    handleReasoningChange(
                      val === REASONING_DEFAULT_VALUE
                        ? null
                        : (val as ReasoningEffort),
                    );
                  }
                }}
              >
                <SelectTrigger
                  className="w-32"
                  disabled={disabled || modelSettingsMut.isPending}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectList>
                    <SelectItem value={REASONING_DEFAULT_VALUE}>
                      <SelectItemText>
                        {t(
                          "ai:agentConfigs.modelParams.reasoning.defaultOption",
                        )}
                      </SelectItemText>
                      <SelectItemIndicator />
                    </SelectItem>
                    {REASONING_EFFORTS.map((effort) => (
                      <SelectItem key={effort} value={effort}>
                        <SelectItemText>
                          {t(
                            `ai:agentConfigs.modelParams.reasoning.option.${effort}`,
                          )}
                        </SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                    ))}
                  </SelectList>
                </SelectContent>
              </Select>
            </div>

            {/* providerOptions — raw JSON escape hatch; invalid JSON
                keeps the draft and shows the inline hint instead of
                committing. */}
            <div className="flex flex-col gap-2">
              <div className="flex flex-col gap-0.5">
                <span className="text-xs font-medium text-muted-foreground">
                  {t("ai:agentConfigs.modelParams.providerOptions.title")}
                </span>
                <span className="text-[0.6875rem] text-muted-foreground/70">
                  {t(
                    "ai:agentConfigs.modelParams.providerOptions.description",
                  )}
                </span>
              </div>
              <Textarea
                value={localProviderOptions}
                onChange={(e) => {
                  setLocalProviderOptions(e.currentTarget.value);
                  setProviderOptionsInvalid(false);
                }}
                onBlur={(e) => commitProviderOptions(e.currentTarget.value)}
                placeholder={t(
                  "ai:agentConfigs.modelParams.providerOptions.placeholder",
                )}
                className="min-h-24 font-mono text-xs"
                aria-invalid={providerOptionsInvalid}
                disabled={disabled || modelSettingsMut.isPending}
              />
              {providerOptionsInvalid && (
                <p className="text-[0.6875rem] text-destructive">
                  {t(
                    "ai:agentConfigs.modelParams.providerOptions.invalidJson",
                  )}
                </p>
              )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
