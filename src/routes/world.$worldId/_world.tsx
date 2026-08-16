import { useRef } from "react";
import { Outlet, createRoute, useLocation, useParams } from "@tanstack/react-router";

import { spaceLayoutRoute } from "../space.$spaceId/_space";
import { WorldSidebar } from "@/components/world-sidebar";
import { initTimeMapperClient } from "@/lib/timemapper/format";
import type { SpaceId, WorldId } from "@/types";

function WorldLayout() {
  const location = useLocation();
  const { spaceId, worldId } = useParams({
    from: "/space/$spaceId/world/$worldId",
  });

  // Bind the TimeMapper singleton to the current World SYNCHRONOUSLY during
  // render (not in useEffect) so the client is ready BEFORE any child
  // component's effect fires (React fires effects child-first). The ref guard
  // ensures this only runs when the World actually changes.
  // See ADR-0026 for the TimeMapper design.
  const initRef = useRef<{ spaceId: string; worldId: string } | null>(null);
  if (
    initRef.current?.spaceId !== spaceId ||
    initRef.current?.worldId !== worldId
  ) {
    initRef.current = { spaceId, worldId };
    initTimeMapperClient(spaceId as SpaceId, worldId as WorldId);
  }

  // Hide the global WorldSidebar inside full-bleed writing workspaces to give
  // the surface maximum width (ADR-0021): the Novel workspace (three-column
  // chapter surface with its own back button) and the Notes workspace (file
  // tree + content panes, also with its own back affordance).
  const isFullBleedWorkspace =
    /\/space\/[^/]+\/world\/[^/]+\/(novels\/[^/]+|notes)/.test(
      location.pathname,
    );

  if (isFullBleedWorkspace) {
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
