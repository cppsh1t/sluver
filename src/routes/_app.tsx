import { Outlet, createRoute } from "@tanstack/react-router";

import { rootRoute } from "./__root";
import { AppSidebar } from "@/components/app-sidebar";

function AppLayout() {
  return (
    <>
      <AppSidebar />
      <main className="flex flex-1 flex-col overflow-hidden">
        <Outlet />
      </main>
    </>
  );
}

export const appLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  id: "app",
  component: AppLayout,
});
