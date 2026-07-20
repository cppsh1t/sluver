import { useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Add01Icon } from "@hugeicons/core-free-icons";

import { appLayoutRoute } from "./_app";
import appIcon from "@/assets/app-icon.png";
import { CreateSpaceDialog } from "@/components/space-management";
import { Button } from "@/components/ui/button";

/**
 * Landing tier (ADR-0009) — shown when no Space tab is open (first run, or
 * after the user closes every tab).
 *
 * This sits under `appLayoutRoute`, which already renders `AppSidebar`, and
 * `AppSidebar`'s footer always renders `<SpacePicker />`. The landing page
 * itself is therefore just the hero: brand + a prominent "Create Space"
 * action. The sidebar's picker is the single source of truth for switching
 * Spaces; rendering a second picker here caused a duplicate-UI bug.
 */
function LandingPage() {
  const { t } = useTranslation(["space", "common"]);
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4 py-16">
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img
          src={appIcon}
          alt="sluver"
          className="size-14 rounded-lg shadow-sm"
        />
        <div className="flex flex-col gap-1.5">
          <h1 className="font-heading text-3xl font-semibold tracking-tight">
            {t("space:landing.title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("space:landing.subtitle")}
          </p>
        </div>

        <Button
          variant="outline"
          onClick={() => setCreateOpen(true)}
          className="w-full"
        >
          <HugeiconsIcon icon={Add01Icon} data-icon="inline-start" strokeWidth={2} />
          {t("space:landing.createSpace")}
        </Button>
      </div>

      <CreateSpaceDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

export const indexRoute = createRoute({
  getParentRoute: () => appLayoutRoute,
  path: "/",
  component: LandingPage,
});
