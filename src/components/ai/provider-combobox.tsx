import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Search01Icon,
} from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { useSetProviderCredential } from "@/hooks";
import type { CatalogProvider } from "@/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

/**
 * "Add provider" flow: opens a dialog with a searchable list of catalog
 * providers, lets the user pick one, enter its API key, and save.
 *
 * The search is a naive `toLowerCase().includes` — no fuse.js dependency.
 * Providers already in `existingProviderIds` are greyed out with an
 * "Added" label (UPSERT semantics mean re-adding is technically possible
 * via the backend, but the UI steers users toward the edit path instead).
 *
 * Flow: pick provider → inline API key field appears → save → close.
 */
export function ProviderCombobox({
  spaceId,
  catalogProviders,
  existingProviderIds,
  disabled,
}: {
  spaceId: Parameters<typeof useSetProviderCredential>[0];
  catalogProviders: CatalogProvider[];
  existingProviderIds: Set<string>;
  disabled?: boolean;
}) {
  const { t } = useTranslation("ai");
  const setMut = useSetProviderCredential(spaceId);

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedProvider, setSelectedProvider] =
    useState<CatalogProvider | null>(null);
  const [apiKey, setApiKey] = useState("");

  // Reset transient state whenever the dialog closes.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setSelectedProvider(null);
      setApiKey("");
    }
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return catalogProviders;
    return catalogProviders.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.id.toLowerCase().includes(q) ||
        (p.npm?.toLowerCase().includes(q) ?? false),
    );
  }, [catalogProviders, query]);

  async function handleSave() {
    if (!selectedProvider || !apiKey.trim()) return;
    const provider = selectedProvider;
    const key = apiKey.trim();
    try {
      await setMut.mutateAsync({ providerId: provider.id, apiKey: key });
      toast.success(i18n.t("ai:providers.toast.saveSuccess"));
      setOpen(false);
    } catch (err) {
      toast.error(i18n.t("ai:providers.toast.saveFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  return (
    <>
      <Button
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={disabled}
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} data-icon="inline-start" />
        {t("ai:providers.add")}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("ai:providers.add")}</DialogTitle>
            <DialogDescription>
              {t("ai:providers.searchPlaceholder")}
            </DialogDescription>
          </DialogHeader>

          {!selectedProvider ? (
            <div className="flex flex-col gap-2">
              <div className="relative">
                <HugeiconsIcon
                  icon={Search01Icon}
                  strokeWidth={2}
                  className="absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-muted-foreground"
                />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                  placeholder={t("ai:providers.searchPlaceholder")}
                  className="pl-7"
                  autoFocus
                />
              </div>

              <div className="max-h-64 overflow-y-auto rounded-md border">
                {filtered.length === 0 ? (
                  <p className="px-3 py-6 text-center text-xs/relaxed text-muted-foreground">
                    {t("ai:providers.searchEmpty")}
                  </p>
                ) : (
                  <ul className="divide-y divide-border">
                    {filtered.map((p) => {
                      const added = existingProviderIds.has(p.id);
                      return (
                        <li key={p.id}>
                          <button
                            type="button"
                            disabled={added}
                            onClick={() => setSelectedProvider(p)}
                            className={cn(
                              "flex w-full items-center gap-2.5 px-3 py-2 text-left transition-colors",
                              "hover:bg-accent hover:text-accent-foreground",
                              "disabled:pointer-events-none disabled:opacity-50",
                            )}
                          >
                            {p.iconUrl ? (
                              <img
                                src={p.iconUrl}
                                alt=""
                                className="size-4 shrink-0 rounded-sm object-contain"
                              />
                            ) : (
                              <span className="flex size-4 shrink-0 items-center justify-center rounded-sm bg-muted text-[0.5rem] font-medium uppercase text-muted-foreground">
                                {p.name.charAt(0)}
                              </span>
                            )}
                            <span className="flex-1 truncate text-xs/relaxed font-medium">
                              {p.name}
                            </span>
                            {added && (
                              <span className="shrink-0 text-[0.625rem] text-muted-foreground">
                                {t("ai:providers.added")}
                              </span>
                            )}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2.5">
                {selectedProvider.iconUrl ? (
                  <img
                    src={selectedProvider.iconUrl}
                    alt=""
                    className="size-5 shrink-0 rounded-sm object-contain"
                  />
                ) : (
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[0.625rem] font-medium uppercase text-muted-foreground">
                    {selectedProvider.name.charAt(0)}
                  </span>
                )}
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-xs/relaxed font-medium">
                    {selectedProvider.name}
                  </span>
                  {selectedProvider.npm && (
                    <span className="truncate font-mono text-[0.625rem] text-muted-foreground">
                      {selectedProvider.npm}
                    </span>
                  )}
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor="ai-provider-apikey"
                  className="text-xs/relaxed font-medium"
                >
                  {t("ai:providers.apiKeyLabel")}
                </label>
                <Input
                  id="ai-provider-apikey"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.currentTarget.value)}
                  placeholder={t("ai:providers.apiKeyPlaceholder")}
                  autoFocus
                />
              </div>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  onClick={() => setSelectedProvider(null)}
                >
                  {t("ai:providers.cancel")}
                </Button>
                <Button
                  onClick={handleSave}
                  disabled={!apiKey.trim() || setMut.isPending}
                >
                  {setMut.isPending
                    ? t("ai:providers.saving")
                    : t("ai:providers.save")}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
