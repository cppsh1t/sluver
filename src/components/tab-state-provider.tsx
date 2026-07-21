/**
 * Per-Space "last route" registry — Tab state URL tracking (ADR-0010).
 *
 * Maintains a `Map<SpaceId, pathname>` recording the most recent route
 * visited within each open Space. The title bar uses `getLastRoute`
 * to navigate back to a Space's last deep route on tab activation
 * (instead of always resetting to `/space/$spaceId`).
 *
 * `clearSpaceTabState` is the close-tab cleanup hook: it drops the
 * Space's `lastRoute` entry AND evicts every cached DOM subtree for
 * that Space via `useKeepAlive().clearByPrefix('/space/<id>/')`
 * (ADR-0010 § Consequences).
 *
 * `TabStateProvider` is a CONSUMER of `KeepAliveProvider` — it MUST
 * be rendered INSIDE `<KeepAliveProvider>`.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useRouterState } from "@tanstack/react-router";

import type { SpaceId } from "@/types";
import { useKeepAlive } from "@/components/keep-alive-outlet";

export interface TabStateApi {
  /** Returns the last route visited in this Space, or `undefined` if never visited. */
  getLastRoute(spaceId: SpaceId): string | undefined;
  /**
   * Clear all Tab state for a Space. Drops the `lastRoute` entry AND
   * evicts every cached DOM subtree under `/space/<id>/` via
   * `KeepAliveProvider.clearByPrefix`. Called by `handleClose` in
   * `title-bar.tsx` after `closeSpace.mutateAsync` resolves.
   */
  clearSpaceTabState(spaceId: SpaceId): void;
}

const TabStateContext = createContext<TabStateApi | null>(null);

// Matches `/space/<spaceId>` and any deeper path under it. Capture
// group 1 = spaceId segment (stops at the next `/`). Both the bare
// `/space/<id>` home AND deep routes like `/space/<id>/world/…` match,
// so the lastRoute is updated even when the user navigates back to
// the Space home from a deep route. Without this, switching tabs would
// yank the user back to the deep route they had already left.
const SPACE_PATH_RE = /^\/space\/([^/]+)/;

export function TabStateProvider({ children }: { children: ReactNode }) {
  // lastRoute per Space. `useRef` (not state) — mutations must not
  // trigger re-renders; the effect below mirrors router state into
  // the map, and consumers read via `getLastRoute` on demand.
  const lastRouteBySpaceRef = useRef<Map<SpaceId, string>>(new Map());

  const { clearByPrefix } = useKeepAlive();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Mirror the current pathname into the per-Space map whenever it
  // changes. Router state already drove the re-render that produced
  // `pathname`, so a plain sync effect is enough — no extra
  // subscription. The capture group is a `string`; cast to the
  // branded `SpaceId` at this boundary (same pattern as
  // `spaceId as SpaceId` in `_space.tsx`).
  useEffect(() => {
    const match = SPACE_PATH_RE.exec(pathname);
    if (!match) return;
    const spaceId = match[1] as SpaceId;
    lastRouteBySpaceRef.current.set(spaceId, pathname);
  }, [pathname]);

  const getLastRoute = useCallback(
    (spaceId: SpaceId): string | undefined =>
      lastRouteBySpaceRef.current.get(spaceId),
    [],
  );

  const clearSpaceTabState = useCallback(
    (spaceId: SpaceId): void => {
      lastRouteBySpaceRef.current.delete(spaceId);
      // No trailing slash: matches both `/space/<id>` (home) AND
      // `/space/<id>/world/…` (deep routes). Space IDs are UUID v7
      // (36 chars, hyphen-separated), so there is zero collision risk
      // with another Space's path prefix.
      clearByPrefix(`/space/${spaceId}`);
    },
    [clearByPrefix],
  );

  const value = useMemo<TabStateApi>(
    () => ({ getLastRoute, clearSpaceTabState }),
    [getLastRoute, clearSpaceTabState],
  );

  return (
    <TabStateContext.Provider value={value}>
      {children}
    </TabStateContext.Provider>
  );
}

/**
 * Public hook for Tab state consumers (title bar, future AI Chat
 * registry). MUST be called inside `<TabStateProvider>` (which itself
 * must be inside `<KeepAliveProvider>`).
 */
export function useTabState(): TabStateApi {
  const ctx = useContext(TabStateContext);
  if (ctx === null) {
    throw new Error("useTabState() must be used inside <TabStateProvider>");
  }
  return ctx;
}
