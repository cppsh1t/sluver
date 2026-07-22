import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertCircleIcon,
  Refresh01Icon,
} from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { toErrorPayload } from "@/api/client";
import { useRefreshModelsDevCatalog } from "@/hooks";
import { Button } from "@/components/ui/button";
import { formatRelativeTime } from "@/lib/format";

/**
 * A dismissible-style warning bar shown when the models.dev catalog is stale
 * — i.e. the last refresh attempt failed and the backend served the previous
 * cached copy. Lets the user retry the fetch manually.
 *
 * Rendered conditionally (only when `catalog.isStale === true`), so this
 * component never shows in the happy path.
 */
export function CatalogStatusBanner({
  fetchedAt,
}: {
  fetchedAt: string;
}) {
  const { t } = useTranslation(["ai", "common"]);
  const refreshMut = useRefreshModelsDevCatalog();

  async function handleRefresh() {
    try {
      await refreshMut.mutateAsync();
      toast.success(i18n.t("ai:catalog.toast.refreshSuccess"));
    } catch (err) {
      toast.error(i18n.t("ai:catalog.toast.refreshFailed"), {
        description: translateError(toErrorPayload(err)),
      });
    }
  }

  return (
    <div
      role="status"
      className="flex items-center gap-3 rounded-lg border border-yellow-500/30 bg-yellow-500/5 px-3 py-2.5"
    >
      <HugeiconsIcon
        icon={AlertCircleIcon}
        strokeWidth={2}
        className="size-4 shrink-0 text-yellow-600 dark:text-yellow-500"
      />
      <p className="flex-1 text-xs/relaxed text-yellow-700 dark:text-yellow-400">
        {t("ai:catalog.staleBanner", {
          fetchedAt: formatRelativeTime(fetchedAt),
        })}
      </p>
      <Button
        size="sm"
        variant="outline"
        onClick={handleRefresh}
        disabled={refreshMut.isPending}
      >
        <HugeiconsIcon
          icon={Refresh01Icon}
          strokeWidth={2}
          data-icon="inline-start"
          className={refreshMut.isPending ? "animate-spin" : undefined}
        />
        {refreshMut.isPending
          ? t("ai:catalog.refreshing")
          : t("ai:catalog.refresh")}
      </Button>
    </div>
  );
}
