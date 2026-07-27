import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon } from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { useDeleteProviderCredential } from "@/hooks";
import type { AgentConfig, CatalogProvider, ProviderCredential } from "@/types";
import { Button } from "@/components/ui/button";
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
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/**
 * Resolve a provider's display name from the catalog, falling back to its id.
 * The catalog may be loading (or stale) so we tolerate a missing entry.
 */
function providerName(
  cred: ProviderCredential,
  catalogById: Map<string, CatalogProvider>,
): string {
  return catalogById.get(cred.providerId)?.name ?? cred.providerId;
}

/**
 * List of configured provider credentials with delete affordances.
 *
 * Deleting a provider cascades server-side: any agent config whose `modelId`
 * starts with `"{providerId}/"` gets cleared. We compute the affected agent
 * config list client-side from the current agent config cache and show it in
 * the confirm dialog before the IPC call, so the user knows exactly what
 * they're about to lose.
 */
export function ProviderCredentialList({
  spaceId,
  credentials,
  catalogProviders,
  agentConfigs,
}: {
  spaceId: Parameters<typeof useDeleteProviderCredential>[0];
  credentials: ProviderCredential[];
  catalogProviders: CatalogProvider[];
  agentConfigs: AgentConfig[];
}) {
  const { t } = useTranslation(["ai", "common"]);
  const deleteMut = useDeleteProviderCredential(spaceId);

  const [pendingDelete, setPendingDelete] = useState<ProviderCredential | null>(
    null,
  );

  const catalogById = useMemo(() => {
    const m = new Map<string, CatalogProvider>();
    for (const p of catalogProviders) m.set(p.id, p);
    return m;
  }, [catalogProviders]);

  async function confirmDelete() {
    if (!pendingDelete) return;
    const cred = pendingDelete;
    setPendingDelete(null);
    try {
      await deleteMut.mutateAsync(cred.id);
      toast.success(i18n.t("ai:providers.toast.deleteSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:providers.toast.deleteFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  if (credentials.length === 0) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
          </EmptyMedia>
          <EmptyTitle>{t("ai:providers.empty.title")}</EmptyTitle>
          <EmptyDescription>
            {t("ai:providers.empty.description")}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  // Agent configs affected by deleting `pendingDelete` — computed here so the
  // confirmation dialog can list them.
  const affectedAgentConfigs = pendingDelete
    ? agentConfigs.filter(
        (ac) =>
          ac.modelId?.startsWith(`${pendingDelete.providerId}/`),
      )
    : [];

  return (
    <>
      <ul className="flex flex-col divide-y divide-border">
        {credentials.map((cred) => {
          const cat = catalogById.get(cred.providerId);
          const name = providerName(cred, catalogById);
          return (
            <li
              key={cred.id}
              className="flex items-center gap-3 py-2.5"
            >
              {cat?.iconUrl ? (
                <img
                  src={cat.iconUrl}
                  alt=""
                  className="size-5 shrink-0 rounded-sm object-contain"
                />
              ) : (
                <span className="flex size-5 shrink-0 items-center justify-center rounded-sm bg-muted text-[0.625rem] font-medium uppercase text-muted-foreground">
                  {name.charAt(0)}
                </span>
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="truncate text-xs/relaxed font-medium">
                  {name}
                </span>
                {cat?.npm && (
                  <span className="truncate font-mono text-[0.625rem] text-muted-foreground">
                    {cat.npm}
                  </span>
                )}
              </div>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t("ai:providers.delete.title")}
                onClick={() => setPendingDelete(cred)}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </li>
          );
        })}
      </ul>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent size="default">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("ai:providers.delete.title")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("ai:providers.delete.description", {
                name: pendingDelete
                  ? providerName(pendingDelete, catalogById)
                  : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>

          {affectedAgentConfigs.length > 0 && (
            <div className={cn("flex flex-col gap-1")}>
              <p className="text-xs/relaxed text-muted-foreground">
                {t("ai:providers.delete.cascadeWarning")}
              </p>
              <ul className="ml-4 flex list-disc flex-col gap-0.5 text-xs/relaxed text-muted-foreground">
                {affectedAgentConfigs.map((ac) => (
                  <li key={ac.id}>
                    {t(`ai:agentConfigs.name.${ac.name}`, {
                      defaultValue: ac.name,
                    })}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleteMut.isPending}
            >
              {t("ai:providers.delete.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
