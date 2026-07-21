/**
 * In-app DOM keep-alive — preserves Tab state across route switches
 * (ADR-0010).
 *
 * Every visited route's subtree is kept mounted in the DOM (hidden via
 * CSS when inactive), so switching tabs and back restores useState,
 * form drafts, scroll, focus, and (future) in-flight AI streams. The
 * cache lives inside this provider at the top of the tree; cache key
 * is the full route pathname.
 *
 * Implementation: snapshot the TanStack Router instance via
 * `lodash/cloneDeep` (deep-clones the router state at the moment of
 * first visit; functions are preserved by reference). Re-provide that
 * snapshot via `<RouterContextProvider>` so hooks inside the cached
 * subtree (`useRouterState`, etc.) read the FROZEN router state
 * instead of the live one. All cached subtrees render simultaneously;
 * CSS toggles visibility based on the current pathname.
 *
 * Close-tab cleanup: `clearByPrefix('/space/<id>/')` evicts every
 * cached subtree for that Space (ADR-0010 § Consequences).
 *
 * Note on the public API used here: ADR-0010 was drafted against an
 * older TanStack Router that exported `getRouterContext()`. In
 * v1.170.x that export is gone; the functionally-equivalent public
 * surface is `useRouter()` + `<RouterContextProvider>`. The deep
 * clone produces the same snapshot; the wrapper produces the same
 * `<routerContext.Provider value={snap}>` shape under the hood.
 */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import {
  Outlet,
  RouterContextProvider,
  useRouter,
  useRouterState,
} from "@tanstack/react-router";
import cloneDeep from "lodash/cloneDeep";

/**
 * Public return type of `useKeepAlive()`. Kept deliberately narrow so
 * the registry can be swapped without leaking internals to consumers.
 */
export interface KeepAliveApi {
  /** Remove every cached entry whose key starts with `prefix`. Returns the count removed. */
  clearByPrefix(prefix: string): number;
  /** Current number of cached route subtrees. */
  getSize(): number;
}

/**
 * Internal context value. Adds `cache` + `setCachedNode` to the public
 * API — `KeepAliveOutlet` (the only internal consumer) uses these to
 * populate the cache. The public `useKeepAlive()` hook narrows back to
 * `KeepAliveApi` so external callers can't poke the cache directly.
 */
interface KeepAliveContextValue extends KeepAliveApi {
  cache: Map<string, ReactNode>;
  setCachedNode(pathname: string, node: ReactNode): void;
  /**
   * Monotonically increasing counter, bumped on every cache eviction
   * (`clearByPrefix` that removed ≥1 entry). `KeepAliveOutlet` subscribes
   * to this so it re-renders after the cache Map is mutated in place —
   * Map mutation doesn't change the Map's identity, so without this
   * nonce, `KeepAliveOutlet` would never reconcile after eviction
   * unless something else (e.g. a pathname change, or an unrelated
   * re-render of its host layout) happened to trigger a render.
   */
  evictionNonce: number;
}

const KeepAliveContext = createContext<KeepAliveContextValue | null>(null);

/** Warn-once threshold (ADR-0010 § Consequences). */
const WARN_THRESHOLD = 50;

export function KeepAliveProvider({ children }: { children: ReactNode }) {
  // Cache of frozen route subtrees keyed by pathname. A `useRef` (not
  // state) on purpose: writes must NOT trigger re-renders. Re-renders
  // are driven by `useRouterState` selecting `pathname` inside
  // `KeepAliveOutlet`, which is the only place that mutates the cache
  // via `setCachedNode`. Evictions (`clearByPrefix`) are handled by
  // the separate `evictionNonce` below.
  const cacheRef = useRef<Map<string, ReactNode>>(new Map());
  // Tracks the size at the previous mutation so we can fire the
  // over-threshold warning only on the >50 crossing (not on every
  // subsequent addition). Reset on `clearByPrefix` so re-population
  // after eviction can re-warn.
  const prevSizeRef = useRef(0);
  // Eviction nonce — bumped on every `clearByPrefix` that removes ≥1
  // entry. This is the mechanism by which `KeepAliveOutlet` learns it
  // needs to re-render after the cache Map is mutated in place. Without
  // it, eviction only takes effect when an unrelated re-render (e.g.
  // `SpaceLayout`'s `useSession()` subscription firing) happens to
  // pass through `KeepAliveOutlet`. Using a `useReducer` counter instead
  // of `useState<number>` to convey "increment-only, no meaningful
  // payload" intent.
  const [evictionNonce, bumpEviction] = useReducer((n: number) => n + 1, 0);

  const setCachedNode = useCallback((pathname: string, node: ReactNode) => {
    cacheRef.current.set(pathname, node);
    const size = cacheRef.current.size;
    if (prevSizeRef.current <= WARN_THRESHOLD && size > WARN_THRESHOLD) {
      // Dev ergonomics: warn once when crossing the >50 threshold
      // (ADR-0010 § Consequences). Production builds strip this via
      // oxlint's `no-console: warn` rule.
      // oxlint-disable-next-line no-console
      console.warn(
        `[keep-alive] ${size} cached route subtrees — potential memory pressure (ADR-0010 § Consequences).`,
      );
    }
    prevSizeRef.current = size;
  }, []);

  const clearByPrefix = useCallback((prefix: string): number => {
    const cache = cacheRef.current;
    let removed = 0;
    for (const key of Array.from(cache.keys())) {
      if (key.startsWith(prefix)) {
        cache.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) {
      prevSizeRef.current = cache.size;
      // Bump the eviction nonce so `KeepAliveOutlet` re-renders and
      // reconciles the DOM against the mutated cache, unmounting the
      // evicted subtrees. Without this, eviction only "works" if some
      // unrelated re-render happens to pass through KeepAliveOutlet —
      // a fragile invariant we don't want to depend on.
      bumpEviction();
    }
    return removed;
  }, []);

  const getSize = useCallback(() => cacheRef.current.size, []);

  // Cache identity is stable (same `Map` for the provider's lifetime),
  // and the methods are `useCallback`-memoised — so this `value` memo
  // only invalidates when `evictionNonce` bumps (after a successful
  // `clearByPrefix`). That propagation is intentional: it's what makes
  // `KeepAliveOutlet` re-render after eviction.
  const value = useMemo<KeepAliveContextValue>(
    () => ({
      cache: cacheRef.current,
      setCachedNode,
      clearByPrefix,
      getSize,
      evictionNonce,
    }),
    [setCachedNode, clearByPrefix, getSize, evictionNonce],
  );

  return (
    <KeepAliveContext.Provider value={value}>
      {children}
    </KeepAliveContext.Provider>
  );
}

/**
 * Public hook for KeepAlive registry consumers (e.g. TabStateProvider's
 * close-tab cleanup). MUST be called inside `<KeepAliveProvider>`.
 */
export function useKeepAlive(): KeepAliveApi {
  const ctx = useContext(KeepAliveContext);
  if (ctx === null) {
    throw new Error("useKeepAlive() must be used inside <KeepAliveProvider>");
  }
  return ctx;
}

/**
 * Drop-in replacement for `<Outlet />` from TanStack Router. Renders
 * every cached route subtree simultaneously, showing the one matching
 * the current pathname and hiding the rest with `display: none`.
 *
 * MUST be used inside `<KeepAliveProvider>`. On first visit to a route
 * the snapshot is taken; subsequent renders of that route reuse the
 * cached subtree (with its frozen router context).
 */
export function KeepAliveOutlet() {
  // `useRouter()` returns the same value that the internal
  // `routerContext` provides — the live router instance.
  const router = useRouter();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  const ctx = useContext(KeepAliveContext);
  if (ctx === null) {
    throw new Error("KeepAliveOutlet must be used inside <KeepAliveProvider>");
  }
  const { cache, setCachedNode, evictionNonce } = ctx;
  // `evictionNonce` is read to subscribe to eviction events. When
  // `clearByPrefix` mutates the cache Map in place (no identity change),
  // this nonce bumps and forces this component to re-render — which
  // reconciles the DOM against the mutated cache, unmounting evicted
  // subtrees. Without this subscription, eviction relies on an
  // unrelated re-render passing through, which is a fragile invariant.
  void evictionNonce;

  // First visit to this pathname: snapshot the router instance (deep
  // clone — see ADR-0010 Issue #3; `structuredClone` would throw on
  // function values, and the standalone `lodash.clonedeep` package
  // stack-overflows on the router's circular `processedTree` refs).
  // The cloned value freezes the cached subtree's view of router
  // state; functions are kept by reference so router methods still
  // work inside the cached component tree. `RouterContextProvider`
  // is the public-API equivalent of `<routerContext.Provider>` —
  // see the file header note.
  if (!cache.has(pathname)) {
    const snapshot = cloneDeep(router);
    setCachedNode(
      pathname,
      (
        <RouterContextProvider router={snapshot}>
          <Outlet />
        </RouterContextProvider>
      ),
    );
  }

  return (
    <>
      {Array.from(cache.entries()).map(([key, node]) => (
        // `display: 'contents'` on the visible entry makes the wrapper
        // invisible to layout — its children become flex/grid items of
        // the grandparent (`_space.tsx`'s `flex` container), preserving
        // `flex-1` / `h-full` / etc. on cached route roots that were
        // originally direct Outlet children. Hidden entries use
        // `display: 'none'` to remove them from layout entirely (their
        // component trees stay mounted but invisible).
        <div
          key={key}
          style={{ display: key === pathname ? "contents" : "none" }}
        >
          {node}
        </div>
      ))}
    </>
  );
}
