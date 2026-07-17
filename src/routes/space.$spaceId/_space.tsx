import { Outlet, createRoute, useParams } from "@tanstack/react-router";

import { rootRoute } from "../__root";
import { SpacePasswordGate } from "@/components/space-password-gate";
import { useSpaces, useSession } from "@/hooks";
import type { SpaceId } from "@/types";

/**
 * Space-tier layout (ADR-0009).
 *
 * This is a **passthrough + locked-gate wrapper** — it deliberately does NOT
 * render `AppSidebar`. Rendering the sidebar here would double it up with
 * `WorldSidebar` (rendered by `_world.tsx`) on every `/space/$spaceId/world/…`
 * route, violating ADR-0005/0009's single-sidebar rule. Instead, each child
 * owns its own sidebar:
 *   - space-home (`index.tsx`) renders `AppSidebar` (context-sensitive).
 *   - world routes render `WorldSidebar` via `_world.tsx`.
 *
 * The wrapper's one cross-cutting concern is the password gate: when the
 * route's Space is in `lockedSpaceIds`, the gate overlays the whole content
 * (sidebar + main) so a locked Space hides ALL of its data while leaving the
 * TitleBar tabs clickable (the gate is an in-page overlay, NOT a modal — see
 * CONTEXT.md + ADR-0008).
 */
function SpaceLayout() {
  // TanStack Router exposes path params as plain `string`; the session's
  // `lockedSpaceIds` and the gate carry the branded `SpaceId`. Cast at the
  // boundary — same pattern as `worldId as WorldId` in `world-sidebar.tsx`.
  const { spaceId } = useParams({ from: "/space/$spaceId" });
  const spaceIdBranded = spaceId as SpaceId;
  const sessionQ = useSession();
  const spacesQ = useSpaces();

  const lockedIds = new Set(sessionQ.data?.lockedSpaceIds ?? []);
  const isLocked = lockedIds.has(spaceIdBranded);
  const spaceName =
    spacesQ.data?.find((s) => s.id === spaceIdBranded)?.name ?? spaceId;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      <Outlet />
      {isLocked && (
        <SpacePasswordGate spaceId={spaceIdBranded} spaceName={spaceName} />
      )}
    </div>
  );
}

export const spaceLayoutRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "space/$spaceId",
  component: SpaceLayout,
});
