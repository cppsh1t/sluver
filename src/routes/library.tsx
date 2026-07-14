import { createRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { appLayoutRoute } from "./_app";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { HugeiconsIcon } from "@hugeicons/react";
import { BookOpen02Icon } from "@hugeicons/core-free-icons";

function LibraryPage() {
  const { t } = useTranslation("common");

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={BookOpen02Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>{t("status.libraryComingSoon.title")}</EmptyTitle>
            <EmptyDescription>
              {t("status.libraryComingSoon.description")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  );
}

export const libraryRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/library",
  component: LibraryPage,
});
