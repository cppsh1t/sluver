import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CatalogModel, CatalogProvider } from "@/types";
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

/**
 * Tri-state image-input test for the `"vision"` agent's picker (ADR-0045),
 * reusing ADR-0044 §D9 semantics: `false` ONLY when the catalog positively
 * knows the model lacks image input. `null`/absent `inputModalities`
 * (unknown — e.g. self-hosted OpenAI-compatible models) stays selectable
 * so a deliberate custom vision setup is never hidden.
 */
function isImageSelectable(m: CatalogModel): boolean {
  return m.inputModalities == null || m.inputModalities.includes("image");
}

/**
 * The cascading provider → model selector used by the agent config model picker.
 *
 * The provider list is pre-filtered to only those with a configured API key
 * (passed in via `availableProviderIds`). When a provider is selected, the
 * model dropdown populates from that provider's catalog entry. Selecting
 * `null` (the explicit "None" item) clears the model binding.
 *
 * Values flow upward via `onValueChange(providerId | null, modelId | null)`:
 * the parent assembles the composite `"{providerId}/{modelId}"` string for
 * the IPC layer.
 */
export function ModelCascadingSelect({
  providers,
  availableProviderIds,
  selectedProviderId,
  selectedModelId,
  disabled,
  requireImageInput,
  onProviderChange,
  onModelChange,
}: {
  /** All catalog providers (used to resolve model lists). */
  providers: CatalogProvider[];
  /** Provider ids that have a credential — the first dropdown's option set. */
  availableProviderIds: Set<string>;
  /** Currently selected provider id, or `null`. */
  selectedProviderId: string | null;
  /** Currently selected model id (within the provider), or `null`. */
  selectedModelId: string | null;
  /** Disable both dropdowns (e.g. catalog still loading). */
  disabled?: boolean;
  /**
   * Restrict the model list to image-input-capable models (the `"vision"`
   * agent, ADR-0045). Known text-only models are hidden from the model
   * dropdown, and providers left with no selectable model are hidden from
   * the provider dropdown. Unknown capability (`inputModalities` null /
   * absent) remains selectable — see {@link isImageSelectable}.
   */
  requireImageInput?: boolean;
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (modelId: string | null) => void;
}) {
  const { t } = useTranslation("ai");

  // Build the provider option list in catalog order, filtered to credentialed
  // providers. Catalog order is the natural display order from models.dev.
  // Under `requireImageInput`, a provider only qualifies while it still has
  // at least one selectable (known-vision or unknown-capability) model.
  const providerOptions = useMemo(
    () =>
      providers.filter((p) => {
        if (!availableProviderIds.has(p.id)) return false;
        if (!requireImageInput) return p.models.length > 0;
        return p.models.some(isImageSelectable);
      }),
    [providers, availableProviderIds, requireImageInput],
  );

  // Resolve the active provider object so we can render its model list.
  const activeProvider = selectedProviderId
    ? (providers.find((p) => p.id === selectedProviderId) ?? null)
    : null;

  // The model dropdown's option set — filtered for the vision role, plain
  // catalog order otherwise.
  const visibleModels = useMemo(
    () =>
      activeProvider
        ? requireImageInput
          ? activeProvider.models.filter(isImageSelectable)
          : activeProvider.models
        : [],
    [activeProvider, requireImageInput],
  );

  const hasProviders = providerOptions.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <Select
          value={selectedProviderId ?? null}
          onValueChange={(val) => {
            onProviderChange(typeof val === "string" ? val : null);
          }}
        >
          <SelectTrigger
            className="w-36"
            disabled={disabled || !hasProviders}
          >
            <SelectValue
              className="truncate"
              placeholder={t("ai:agentConfigs.providerPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            <SelectList>
              {/* Explicit "None" item so the user can clear a selection. */}
              <SelectItem value={null}>
                <SelectItemText>{t("ai:agentConfigs.nonePlaceholder")}</SelectItemText>
              </SelectItem>
              {providerOptions.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  <SelectItemText>{p.name}</SelectItemText>
                  <SelectItemIndicator />
                </SelectItem>
              ))}
            </SelectList>
          </SelectContent>
        </Select>

        <Select
          value={selectedModelId ?? null}
          onValueChange={(val) => {
            onModelChange(typeof val === "string" ? val : null);
          }}
        >
          <SelectTrigger
            className="min-w-0 flex-1"
            disabled={disabled || !hasProviders || !activeProvider}
          >
            <SelectValue
              className="truncate"
              placeholder={t("ai:agentConfigs.modelPlaceholder")}
            />
          </SelectTrigger>
          <SelectContent>
            {activeProvider && (
              <SelectList>
                <SelectItem value={null}>
                  <SelectItemText>{t("ai:agentConfigs.nonePlaceholder")}</SelectItemText>
                </SelectItem>
                {visibleModels.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    <SelectItemText>{m.name}</SelectItemText>
                    <SelectItemIndicator />
                  </SelectItem>
                ))}
              </SelectList>
            )}
          </SelectContent>
        </Select>
      </div>
      {/* Why some models are missing — only shown for the filtered role. */}
      {requireImageInput && (
        <p className="text-[0.6875rem] text-muted-foreground/70">
          {t("ai:agentConfigs.modelVisionFilterNote")}
        </p>
      )}
    </div>
  );
}
