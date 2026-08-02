import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { arrayBufferToBlobUrl } from "@/lib/image-bytes";
import {
  getCharacterImage,
  getEventImage,
  getLocationImage,
  getLoreImage,
  getItemImage,
  getNovelImage,
  getPhaseImage,
  getWorldImage,
} from "@/api/image";
import { Skeleton } from "@/components/ui/skeleton";
import type {
  CharacterId,
  EventId,
  ItemId,
  LocationId,
  LoreId,
  NovelId,
  PhaseId,
  SpaceId,
  WorldId,
} from "@/types";

/**
 * Lazy, cached thumbnail for any image-bearing entity.
 *
 * Display-only counterpart to {@link ImageCropDialog}: the dialog *produces*
 * WebP bytes, this component *renders* them. It owns no upload path.
 *
 * The image bytes live in the per-entity SQLite blob column and come back over
 * IPC as an `ArrayBuffer`. We turn that into a one-shot blob URL and revoke it
 * when the data changes or the component unmounts, so switching between
 * entities (or invalidating after an upload) never leaks object URLs.
 *
 * Query config: `staleTime: Infinity` — images only change through the
 * explicit `update_*_image` / `clear_*_image` commands, whose callers
 * invalidate `["image", kind, id]` manually. There is no point re-fetching on
 * focus or refetch interval.
 */

export type EntityKind =
  | "world"
  | "character"
  | "phase"
  | "location"
  | "item"
  | "lore"
  | "event"
  | "novel";

/**
 * Default cover aspect per entity kind. Matches the `outputWidth/Height`
 * contract used by the upload dialog so a freshly-uploaded image fills the
 * frame without distortion.
 */
const DEFAULT_ASPECT: Record<EntityKind, number> = {
  world: 16 / 9,
  character: 3 / 4,
  phase: 3 / 4,
  location: 4 / 3,
  item: 1,
  lore: 1,
  event: 16 / 9,
  novel: 2 / 3,
};

/**
 * Union of every entity-id brand this component can address. The `kind`
 * discriminator selects which member applies at runtime; the brand cannot be
 * recovered from `kind` at the type level, so the dispatcher casts once at the
 * trusted boundary (see {@link fetchEntityImage}).
 */
type EntityImageId =
  | CharacterId
  | PhaseId
  | LocationId
  | ItemId
  | LoreId
  | EventId
  | NovelId;

export interface EntityAvatarProps {
  kind: EntityKind;
  spaceId: SpaceId;
  /** World the entity lives in. For `kind === "world"` this is the world itself. */
  worldId: WorldId;
  /**
   * Entity id. Unused for `kind === "world"` (the world has a single cover
   * addressed by `worldId`); required for every other kind.
   */
  id?: EntityImageId;
  /** Override the per-kind default aspect. */
  aspect?: number;
  className?: string;
  /** Shown while loading or when the entity has no image. */
  fallbackIcon?: React.ReactNode;
  alt?: string;
}

/**
 * Pick the right IPC wrapper for the entity kind. `world` is keyed by `worldId`
 * alone (one cover per world); every other kind is addressed by its entity id
 * inside the world.
 *
 * The `kind` runtime switch cannot narrow the branded `id` union at the type
 * level (the brand is not encoded in `kind`), so each non-world branch performs
 * one narrowing cast to the specific brand. This is the single trusted brand
 * boundary in the component — callers pair `kind` + `id`, and we trust that
 * pairing here. These are NOT `as any` casts; each targets a concrete brand
 * that is a member of {@link EntityImageId}.
 */
function fetchEntityImage(
  kind: EntityKind,
  spaceId: SpaceId,
  worldId: WorldId,
  id: EntityImageId | undefined,
): Promise<ArrayBuffer | null> {
  switch (kind) {
    case "world":
      return getWorldImage(spaceId, worldId);
    case "character":
      return getCharacterImage(spaceId, worldId, id as CharacterId);
    case "phase":
      return getPhaseImage(spaceId, worldId, id as PhaseId);
    case "location":
      return getLocationImage(spaceId, worldId, id as LocationId);
    case "item":
      return getItemImage(spaceId, worldId, id as ItemId);
    case "lore":
      return getLoreImage(spaceId, worldId, id as LoreId);
    case "event":
      return getEventImage(spaceId, worldId, id as EventId);
    case "novel":
      return getNovelImage(spaceId, worldId, id as NovelId);
  }
}

export function EntityAvatar({
  kind,
  spaceId,
  worldId,
  id,
  aspect,
  className,
  fallbackIcon,
  alt,
}: EntityAvatarProps) {
  const ratio = aspect ?? DEFAULT_ASPECT[kind];

  // The `world` branch ignores `id`, so the query key must not include it —
  // otherwise two avatars for the same world with different stale `id` props
  // would needlessly split the cache. Non-world kinds are keyed by id.
  const queryKey: readonly unknown[] =
    kind === "world" ? ["image", kind, worldId] : ["image", kind, id];

  const { data, isLoading } = useQuery<ArrayBuffer | null>({
    queryKey,
    queryFn: () => fetchEntityImage(kind, spaceId, worldId, id),
    // `spaceId` / `worldId` are required branded props (always present); the
    // only real gate is `id`, which is optional for `kind === "world"`.
    enabled: kind === "world" || id !== undefined,
    staleTime: Infinity,
    gcTime: Infinity,
  });

  // Blob URL lifecycle. The effect owns exactly one URL at a time: when `data`
  // arrives it builds a new URL and revokes the previous one via cleanup; on
  // unmount the last URL is revoked too. `blobUrlRef` mirrors the live URL for
  // defensive teardown (e.g. React 19 StrictMode double-invoke in dev).
  const blobUrlRef = useRef<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!data) {
      setBlobUrl(null);
      return;
    }
    const url = arrayBufferToBlobUrl(data);
    blobUrlRef.current = url;
    setBlobUrl(url);
    return () => {
      URL.revokeObjectURL(url);
      if (blobUrlRef.current === url) blobUrlRef.current = null;
    };
  }, [data]);

  // Empty image src is invalid; guard before render so we never emit
  // `<img src="">` (which resolves to the page URL and 404s in devtools).
  const src = blobUrl ?? undefined;

  if (isLoading) {
    return (
      <Skeleton
        className={cn("flex items-center justify-center", className)}
        style={{ aspectRatio: String(ratio) }}
      >
        {fallbackIcon}
      </Skeleton>
    );
  }

  if (!src) {
    // No image (null result) — render the fallback inside a muted frame that
    // matches the aspect, so the layout doesn't collapse before upload.
    return (
      <div
        className={cn(
          "flex items-center justify-center bg-muted text-muted-foreground",
          className,
        )}
        style={{ aspectRatio: String(ratio) }}
      >
        {fallbackIcon}
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt ?? ""}
      loading="lazy"
      // decoding="async" lets the browser decode off the main thread, avoiding
      // jank when many avatars mount at once (e.g. a dense card grid).
      decoding="async"
      onError={(e) => {
        // A blob URL that fails to decode usually means a corrupt/unsupported
        // blob — log metadata only (no creative content) per the redaction
        // policy, and tag the element so callers can target it via CSS. For
        // `kind === "world"` there is no `id`, so fall back to `worldId`.
        logger.warn("entity_avatar.image_decode_failed", {
          entity_kind: kind,
          entity_id: id ?? worldId,
        });
        if (e.currentTarget instanceof HTMLImageElement) {
          e.currentTarget.dataset.error = "decode-failed";
        }
      }}
      className={cn("object-cover", className)}
      style={{ aspectRatio: String(ratio) }}
    />
  );
}
