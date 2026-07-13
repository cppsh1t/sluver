import { createRoute, useParams } from "@tanstack/react-router";

import { rootRoute } from "./__root";

function WorldWorkspacePage() {
  const { worldId } = useParams({ from: "/world/$worldId" });

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 p-8 text-center">
      <p className="font-heading text-sm font-medium tracking-tight">
        世界工作区即将推出
      </p>
      <p className="text-xs text-muted-foreground/70">{worldId}</p>
    </div>
  );
}

export const worldRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/world/$worldId",
  component: WorldWorkspacePage,
});
