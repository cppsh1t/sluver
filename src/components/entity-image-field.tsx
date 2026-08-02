import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import i18n from "@/i18n";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import {
  clearCharacterImage,
  clearEventImage,
  clearItemImage,
  clearLocationImage,
  clearLoreImage,
  clearNovelImage,
  clearPhaseImage,
  clearWorldImage,
  updateCharacterImage,
  updateEventImage,
  updateItemImage,
  updateLocationImage,
  updateLoreImage,
  updateNovelImage,
  updatePhaseImage,
  updateWorldImage,
} from "@/api/image";
import { Button } from "@/components/ui/button";
import { EntityAvatar, type EntityKind } from "@/components/ui/entity-avatar";
import { ImageCropDialog } from "@/components/ui/image-crop-dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import { Delete02Icon, ImageUpload01Icon } from "@hugeicons/core-free-icons";
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
 * Inline image-upload affordance shared by every entity form's edit mode.
 *
 * Wraps three primitives:
 *   - {@link EntityAvatar} for the current image (auto-refetches after we
 *     invalidate the `["image", kind, id]` query).
 *   - {@link ImageCropDialog} for the pick → crop → compress → submit flow.
 *   - The polymorphic `update_*_image` / `clear_*_image` IPC wrappers in
 *     `@/api/image`, dispatched on `kind`.
 *
 * On submit: calls the kind-specific update wrapper, invalidates the query
 * key, toasts success/failure, then either closes the dialog (success — the
 * dialog itself does this on resolve) or re-throws (failure — the dialog
 * surfaces the error inline and stays open so the user can retry).
 *
 * On remove: calls the kind-specific clear wrapper, invalidates, toasts.
 * Clearing is idempotent on the Rust side, so the button is always shown
 * even when no image is set.
 *
 * ## Why a dispatcher instead of per-kind components
 *
 * The 8 entity kinds share an identical UI shape (avatar + change + remove
 * + crop dialog); only the IPC endpoint, aspect ratio, and output dimensions
 * vary. Funneling them through one component keeps the per-form diff to a
 * single `<EntityImageField>` element and ensures the toast/invalidate
 * contract stays in sync across all of them.
 *
 * ## Brand narrowing
 *
 * `kind` is a runtime discriminator that TypeScript cannot use to narrow the
 * branded id union — the brand is not encoded in `kind`. Each dispatch branch
 * therefore performs a single narrowing cast to the specific brand, exactly
 * as {@link EntityAvatar} does. These target concrete brands; they are NOT
 * `as any`.
 */

/** Branded ids accepted by the image IPC layer (World is keyed by its own id). */
export type EntityImageId =
  | WorldId
  | CharacterId
  | PhaseId
  | LocationId
  | ItemId
  | LoreId
  | EventId
  | NovelId;

/**
 * Toast namespace per kind. Phase shares the `character` namespace because
 * phases live on the character detail page; Location/Item/Lore share
 * `worldbook` per the existing toast layout.
 */
const TOAST_NAMESPACE: Record<EntityKind, string> = {
  world: "world",
  character: "character",
  phase: "character",
  location: "worldbook",
  item: "worldbook",
  lore: "worldbook",
  event: "event",
  novel: "novel",
};

function dispatchUpdate(
  kind: EntityKind,
  spaceId: string,
  worldId: WorldId,
  id: EntityImageId,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  switch (kind) {
    case "world":
      return updateWorldImage(spaceId, id as WorldId, bytes, mime);
    case "character":
      return updateCharacterImage(spaceId, worldId, id as CharacterId, bytes, mime);
    case "phase":
      return updatePhaseImage(spaceId, worldId, id as PhaseId, bytes, mime);
    case "location":
      return updateLocationImage(spaceId, worldId, id as LocationId, bytes, mime);
    case "item":
      return updateItemImage(spaceId, worldId, id as ItemId, bytes, mime);
    case "lore":
      return updateLoreImage(spaceId, worldId, id as LoreId, bytes, mime);
    case "event":
      return updateEventImage(spaceId, worldId, id as EventId, bytes, mime);
    case "novel":
      return updateNovelImage(spaceId, worldId, id as NovelId, bytes, mime);
  }
}

function dispatchClear(
  kind: EntityKind,
  spaceId: string,
  worldId: WorldId,
  id: EntityImageId,
): Promise<void> {
  switch (kind) {
    case "world":
      return clearWorldImage(spaceId, id as WorldId);
    case "character":
      return clearCharacterImage(spaceId, worldId, id as CharacterId);
    case "phase":
      return clearPhaseImage(spaceId, worldId, id as PhaseId);
    case "location":
      return clearLocationImage(spaceId, worldId, id as LocationId);
    case "item":
      return clearItemImage(spaceId, worldId, id as ItemId);
    case "lore":
      return clearLoreImage(spaceId, worldId, id as LoreId);
    case "event":
      return clearEventImage(spaceId, worldId, id as EventId);
    case "novel":
      return clearNovelImage(spaceId, worldId, id as NovelId);
  }
}

export interface EntityImageFieldProps {
  kind: EntityKind;
  spaceId: string;
  worldId: WorldId;
  /**
   * The entity's own id. For `kind === "world"` this is the world's own id
   * (same value as `worldId`) — World IS the entity, addressed by its id.
   */
  id: EntityImageId;
  /** Crop aspect (e.g. `16/9`, `3/4`, `1`). */
  aspect: number;
  /** Export width in pixels. */
  outputWidth: number;
  /** Export height in pixels. */
  outputHeight: number;
  /** Class on the outer layout wrapper. */
  className?: string;
  /** Avatar size class — defaults to a 96px square. */
  avatarClassName?: string;
  /** Shown inside the avatar while loading or when no image is set. */
  fallbackIcon?: React.ReactNode;
  /** Optional title for the crop dialog. */
  cropTitle?: string;
}

export function EntityImageField({
  kind,
  spaceId,
  worldId,
  id,
  aspect,
  outputWidth,
  outputHeight,
  className,
  avatarClassName,
  fallbackIcon,
  cropTitle,
}: EntityImageFieldProps) {
  const queryClient = useQueryClient();
  const ns = TOAST_NAMESPACE[kind];
  const { t } = useTranslation([ns, "common"]);
  const [cropOpen, setCropOpen] = useState(false);

  // World is keyed by `worldId` alone (one cover per world); every other kind
  // is keyed by its entity id. Match EntityAvatar's key shape exactly so the
  // invalidation lands on the same cache entry.
  const queryKey: readonly unknown[] =
    kind === "world" ? ["image", kind, worldId] : ["image", kind, id];

  async function handleUpload(bytes: Uint8Array, mime: string) {
    try {
      await dispatchUpdate(kind, spaceId, worldId, id, bytes, mime);
      await queryClient.invalidateQueries({ queryKey });
      toast.success(i18n.t(`${ns}:toast.imageUpdated`));
    } catch (e) {
      toast.error(i18n.t(`${ns}:toast.imageUpdateFailed`), {
        description: translateError(toErrorPayload(e)),
      });
      // Re-throw so ImageCropDialog keeps its footer active and the user can
      // retry without re-picking the file. Matches the form-submit pattern.
      throw e;
    }
  }

  async function handleClear() {
    try {
      await dispatchClear(kind, spaceId, worldId, id);
      await queryClient.invalidateQueries({ queryKey });
      toast.success(i18n.t(`${ns}:toast.imageRemoved`));
    } catch (e) {
      toast.error(i18n.t(`${ns}:toast.imageRemoveFailed`), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  return (
    <div className={className}>
      <EntityAvatar
        kind={kind}
        // EntityAvatar's prop is branded `SpaceId`, but the rest of the
        // codebase (and all our form hosts) carry spaceId as a plain string
        // — matching the existing EntityAvatar callers (see character-card,
        // event-card) which cast at the trusted boundary.
        spaceId={spaceId as SpaceId}
        worldId={worldId}
        // World ignores `id` — omit so we don't leak a stale brand into the
        // query key. Other kinds narrow to the union; the brand cannot be
        // recovered from `kind` at the type level (see EntityAvatar).
        id={kind === "world" ? undefined : (id as CharacterId | PhaseId | LocationId | ItemId | LoreId | EventId | NovelId)}
        className={avatarClassName ?? "size-24 rounded-md"}
        fallbackIcon={fallbackIcon}
      />
      <div className="flex flex-col gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setCropOpen(true)}
        >
          <HugeiconsIcon icon={ImageUpload01Icon} strokeWidth={2} data-icon="inline-start" />
          {t("common:imageField.change")}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={handleClear}
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} data-icon="inline-start" />
          {t("common:imageField.remove")}
        </Button>
      </div>

      <ImageCropDialog
        open={cropOpen}
        onOpenChange={setCropOpen}
        aspect={aspect}
        outputWidth={outputWidth}
        outputHeight={outputHeight}
        title={cropTitle}
        onSubmit={handleUpload}
      />
    </div>
  );
}
