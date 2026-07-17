import { Outlet, createRoute, useLocation } from "@tanstack/react-router";

import { spaceLayoutRoute } from "../space.$spaceId/_space";
import { WorldSidebar } from "@/components/world-sidebar";

function WorldLayout() {
  const location = useLocation();
  // Hide the global WorldSidebar inside the Novel workspace to give the
  // three-column writing surface maximum width (ADR-0007). The workspace
  // has its own chapter sidebar with a back button for world navigation.
  const isNovelWorkspace = /\/space\/[^/]+\/world\/[^/]+\/novels\/[^/]+/.test(
    location.pathname,
  );

  if (isNovelWorkspace) {
    return <Outlet />;
  }

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
  getParentRoute: () => spaceLayoutRoute,
  path: "world/$worldId",
  component: WorldLayout,
});
