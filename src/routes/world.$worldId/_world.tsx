import { Outlet, createRoute } from "@tanstack/react-router";

import { rootRoute } from "../__root";
import { WorldSidebar } from "@/components/world-sidebar";

function WorldLayout() {
  return (
    <>
      <WorldSidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </>
  );
}

export const worldLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "world/$worldId",
  component: WorldLayout,
});
