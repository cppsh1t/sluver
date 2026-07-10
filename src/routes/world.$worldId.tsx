import { createRoute, useNavigate, useParams } from "@tanstack/react-router";

import { rootRoute } from "./__root";
import { Button } from "@/components/ui/button";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft01Icon } from "@hugeicons/core-free-icons";

function WorldWorkspacePage() {
  const { worldId } = useParams({ from: "/world/$worldId" });
  const navigate = useNavigate();

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <p className="text-sm text-muted-foreground">
        世界工作区（{worldId}）— 即将推出
      </p>
      <Button variant="outline" onClick={() => navigate({ to: "/" })}>
        <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        返回世界列表
      </Button>
    </div>
  );
}

export const worldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/world/$worldId",
  component: WorldWorkspacePage,
});
