import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { CatalogProvider } from "@/types";
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
 * The cascading provider → model selector used by the agent model picker.
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
  onProviderChange: (providerId: string | null) => void;
  onModelChange: (modelId: string | null) => void;
}) {
  const { t } = useTranslation("ai");

  // Build the provider option list in catalog order, filtered to credentialed
  // providers. Catalog order is the natural display order from models.dev.
  const providerOptions = useMemo(
    () =>
      providers.filter(
        (p) => availableProviderIds.has(p.id) && p.models.length > 0,
      ),
    [providers, availableProviderIds],
  );

  // Resolve the active provider object so we can render its model list.
  const activeProvider = selectedProviderId
    ? (providers.find((p) => p.id === selectedProviderId) ?? null)
    : null;

  const hasProviders = providerOptions.length > 0;

  return (
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
          <SelectValue placeholder={t("ai:agents.providerPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          <SelectList>
            {/* Explicit "None" item so the user can clear a selection. */}
            <SelectItem value={null}>
              <SelectItemText>{t("ai:agents.nonePlaceholder")}</SelectItemText>
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
          className="w-44"
          disabled={disabled || !hasProviders || !activeProvider}
        >
          <SelectValue placeholder={t("ai:agents.modelPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {activeProvider && (
            <SelectList>
              <SelectItem value={null}>
                <SelectItemText>{t("ai:agents.nonePlaceholder")}</SelectItemText>
              </SelectItem>
              {activeProvider.models.map((m) => (
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
  );
}
