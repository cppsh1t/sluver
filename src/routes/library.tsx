import { createRoute } from "@tanstack/react-router";

import { rootRoute } from "./__root";
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
  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center px-6 py-16">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <HugeiconsIcon icon={BookOpen02Icon} strokeWidth={2} />
            </EmptyMedia>
            <EmptyTitle>资料库即将推出</EmptyTitle>
            <EmptyDescription>
              资料库将汇集可在多个世界间复用的角色、地点、物品与设定。当前版本暂未开放。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    </div>
  );
}

export const libraryRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/library",
  component: LibraryPage,
});
