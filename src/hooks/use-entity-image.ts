import { useQuery } from "@tanstack/react-query";

import {
  fetchEntityImage,
  type EntityImageId,
  type EntityKind,
} from "@/components/ui/entity-avatar";
import type { SpaceId, WorldId } from "@/types";

/**
 * Shared React Query hook for entity image bytes.
 *
 * Mirrors the query configuration inside {@link EntityAvatar} so the two
 * share the same cache entry (`["image", kind, id]`). This lets a lightbox
 * or detail dialog resolve instantly after an avatar has already loaded the
 * bytes — no duplicate IPC call.
 *
 * See {@link EntityAvatar} for the redaction / cache rationale
 * (`staleTime: Infinity`, `gcTime: Infinity`).
 */
export function useEntityImageBytes(
  kind: EntityKind,
  spaceId: SpaceId,
  worldId: WorldId,
  id?: EntityImageId,
) {
  const queryKey: readonly unknown[] =
    kind === "world" ? ["image", kind, worldId] : ["image", kind, id];

  return useQuery<ArrayBuffer | null>({
    queryKey,
    queryFn: () => fetchEntityImage(kind, spaceId, worldId, id),
    enabled: kind === "world" || id !== undefined,
    staleTime: Infinity,
    gcTime: Infinity,
  });
}
