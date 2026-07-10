import { Outlet, createRootRoute } from "@tanstack/react-router";

import { Button } from "@/components/ui/button";
import { Toaster } from "@/components/ui/sonner";
import { HugeiconsIcon } from "@hugeicons/react";
import { Settings02Icon } from "@hugeicons/core-free-icons";
import appIcon from "@/assets/app-icon.png";

function RootLayout() {
  return (
    <div className="flex min-h-svh flex-col">
      <header className="flex h-12 shrink-0 items-center justify-between border-b px-4">
        <div className="flex items-center gap-2">
          <img src={appIcon} alt="sluver" className="size-5 rounded-sm" />
          <span className="font-heading text-sm font-medium tracking-tight">
            sluver
          </span>
        </div>
        <Button variant="ghost" size="icon-sm">
          <HugeiconsIcon icon={Settings02Icon} strokeWidth={2} />
          <span className="sr-only">设置</span>
        </Button>
      </header>
      <main className="flex flex-1 overflow-hidden">
        <Outlet />
      </main>
      <Toaster />
    </div>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
