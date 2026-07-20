import { createRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { BookOpen02Icon } from "@hugeicons/core-free-icons";

import { spaceLayoutRoute } from "./_space";
import { AppSidebar } from "@/components/app-sidebar";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";

/**
 * Space-level 资料库 page — placeholder (ADR-0009 amendment).
 *
 * The Library is now a Space-tier destination (sibling of 世界 and 配置 in the
 * sidebar), not a landing-tier global page. Its eventual scope is per-Space
 * reusable material; until it is built out, this renders the same "coming
 * soon" empty state the landing library used to show.
 */
function SpaceLibraryPage() {
  const { t } = useTranslation(["common", "space"]);

  return (
    <>
      <AppSidebar />
      <main className="flex flex-1 flex-col overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <HugeiconsIcon icon={BookOpen02Icon} strokeWidth={2} />
              </EmptyMedia>
              <EmptyTitle>{t("common:status.libraryComingSoon.title")}</EmptyTitle>
              <EmptyDescription>
                {t("common:status.libraryComingSoon.description")}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </main>
    </>
  );
}

export const spaceLibraryRoute = createRoute({
  getParentRoute: () => spaceLayoutRoute,
  path: "library",
  component: SpaceLibraryPage,
});
