import { createRoute, Outlet, useParams } from "@tanstack/react-router";

import { rootRoute } from "../__root";
import { SpacePasswordGate } from "@/components/space-password-gate";
import { ConversationRuntimeProvider } from "@/lib/conversation-runtime";
import { useSpaces, useSession } from "@/hooks";
import type { SpaceId } from "@/types";

/**
 * Space-tier layout (ADR-0011).
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
 * route's Space is in `lockedSpaceIds`, the gate overlays the window's
 * whole content (sidebar + main) so a locked Space hides ALL of its data.
 * Under ADR-0011 each Space is its own OS window, so the gate is an in-page
 * overlay (NOT a modal) — the OS window controls and tray stay available
 * outside the page; see CONTEXT.md + ADR-0008.
 */
function SpaceLayout() {
  // TanStack Router exposes path params as plain `string`; the session's
  // `lockedSpaceIds` and the gate carry the branded `SpaceId`. Cast at the
  // boundary — same pattern as `worldId as WorldId` in `world-sidebar.tsx`.
  const { spaceId } = useParams({ from: "/space/$spaceId" });
  const spaceIdBranded = spaceId as SpaceId;
  const sessionQ = useSession();
  const spacesQ = useSpaces();

  const isLocked = (sessionQ.data?.lockedSpaceIds ?? []).includes(spaceIdBranded);
  const spaceName =
    spacesQ.data?.find((s) => s.id === spaceIdBranded)?.name ?? spaceId;

  return (
    <div className="relative flex flex-1 overflow-hidden">
      {/*
        ConversationRuntimeProvider owns the AI-chat runtime store for the
        lifetime of this Space window (ADR-0011/0024). Mounted here — above the
        world/chapter routes — so every world's conversations share one store
        and in-flight runs survive navigation between them. Hiding the window to
        the tray does not unmount this provider; only destroying the window
        tears the runtime down.
      */}
      <ConversationRuntimeProvider spaceId={spaceIdBranded}>
        <Outlet />
      </ConversationRuntimeProvider>
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
