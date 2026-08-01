import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { getTimeMapper, setTimeMapper } from "@/api/world-config";
import { reloadTimeMapper } from "@/lib/timemapper/format";
import type { SpaceId, WorldId } from "@/types";

// Hooks are toast-free on purpose: components own success/error UX so the
// same hook is reusable across pages that surface errors differently. The
// api client already normalizes rejections to `ErrorPayload`; call sites
// should pipe `.catch`/`onError` through `translateError(toErrorPayload(e))`
// (see AGENTS.md §Error translation pipeline).

// ─── Query key factory ──────────────────────────────────────────────────────

/**
 * Query keys for the per-World TimeMapper config (ADR-0026). Each (Space,
 * World) pair gets its own key namespace so cache invalidation can be scoped
 * precisely.
 */
export const timeMapperKeys = {
  config: (spaceId: SpaceId, worldId: WorldId) =>
    ["timemapper", spaceId, worldId] as const,
};

// ─── Read ───────────────────────────────────────────────────────────────────

/**
 * Loads the current World's mapper source (`null` when none is configured →
 * the UI seeds the editor with {@link DEFAULT_TEMPLATE}). `enabled` guards on
 * both ids being present so the query stays idle during route transitions.
 */
export const useTimeMapper = (spaceId: SpaceId, worldId: WorldId) =>
  useQuery({
    queryKey: timeMapperKeys.config(spaceId, worldId),
    queryFn: () => getTimeMapper(spaceId, worldId),
    enabled: !!spaceId && !!worldId,
  });

// ─── Write ──────────────────────────────────────────────────────────────────

/**
 * Persists new mapper source. On success it invalidates the config query (so
 * the editor's "dirty" state recalculates against the persisted value) AND
 * calls {@link reloadTimeMapper} so the singleton client purges its compiled
 * module + per-ISO cache — every live timestamp re-renders with the new code.
 */
export const useSetTimeMapper = (spaceId: SpaceId, worldId: WorldId) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (code: string) => setTimeMapper(spaceId, worldId, code),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: timeMapperKeys.config(spaceId, worldId) });
      reloadTimeMapper();
    },
  });
};
