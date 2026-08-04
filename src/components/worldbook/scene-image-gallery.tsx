import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import type { DragEndEvent } from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  useSortable,
  rectSortingStrategy,
} from "@dnd-kit/sortable";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Add01Icon,
  Delete02Icon,
  GripVerticalIcon,
} from "@hugeicons/core-free-icons";

import i18n from "@/i18n";
import { toErrorPayload } from "@/api/client";
import { translateError } from "@/i18n/errors";
import { Button } from "@/components/ui/button";
import { ImageCropDialog } from "@/components/ui/image-crop-dialog";
import { useBlobUrl, SceneImageLightbox } from "@/components/worldbook/scene-image-lightbox";
import {
  useAddSceneImage,
  useDeleteSceneImage,
  useReorderSceneImages,
  useSceneImageBytes,
  useSceneImages,
} from "@/hooks";
import { cn } from "@/lib/utils";
import type { SceneId, SceneImageMeta, WorldId } from "@/types";

/**
 * Scene image gallery — renders a Scene's sidecar image list at the bottom of
 * the scene in both edit and read modes.
 *
 * Images are NOT part of the `Scene` entity; they live in a dedicated sidecar
 * table mutated through `add_scene_image` / `delete_scene_image` /
 * `reorder_scene_images` and never touch the scene autosave flow.
 *
 * - **Edit mode**: responsive thumbnail grid + add tile (opens the crop
 *   dialog) + drag-to-reorder + per-image delete. Mutations are optimistic
 *   for reorder and toast on success/failure for add/delete.
 * - **Read mode**: static thumbnail grid only; no controls. Renders nothing
 *   when the scene has no images (prose reading shouldn't show empty states).
 *
 * Both modes open the {@link SceneImageLightbox} on thumbnail click.
 */

/** Crop/export config for scene images. 3:2 landscape suits scene
 *  illustrations and crops cleanly into the square thumbnails. */
const CROP_ASPECT = 3 / 2;
const CROP_OUTPUT_WIDTH = 1200;
const CROP_OUTPUT_HEIGHT = 800;

interface SceneImageGalleryProps {
  spaceId: string;
  worldId: WorldId;
  sceneId: SceneId;
  mode: "edit" | "read";
}

export function SceneImageGallery({
  spaceId,
  worldId,
  sceneId,
  mode,
}: SceneImageGalleryProps) {
  const { t } = useTranslation(["novel", "common"]);
  const isEdit = mode === "edit";

  const { data: serverImages = [] } = useSceneImages(spaceId, worldId, sceneId);
  const addMut = useAddSceneImage(spaceId, worldId, sceneId);
  const deleteMut = useDeleteSceneImage(spaceId, worldId, sceneId);
  const reorderMut = useReorderSceneImages(spaceId, worldId, sceneId);

  // Optimistic order override — set synchronously on drag end so the DOM
  // reorders immediately; cleared once the server list refetches (the
  // invalidate in the mutation hook drives it). Rolled back on error.
  const [orderOverride, setOrderOverride] = useState<SceneImageMeta[] | null>(null);
  useEffect(() => {
    // Any server change (refetch after add/delete/reorder) is authoritative.
    setOrderOverride(null);
  }, [serverImages]);

  const displayImages = orderOverride ?? serverImages;

  // Lightbox state — null = closed, number = index into displayImages.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);
  useEffect(() => {
    // Clamp the lightbox index if the underlying list shrinks (e.g. a
    // delete from another tab) so it never points past the end.
    if (lightboxIndex !== null && lightboxIndex >= displayImages.length) {
      setLightboxIndex(displayImages.length === 0 ? null : displayImages.length - 1);
    }
  }, [displayImages.length, lightboxIndex]);

  const [cropOpen, setCropOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function openLightbox(index: number) {
    setLightboxIndex(index);
  }

  async function handleUpload(bytes: Uint8Array, mime: string) {
    try {
      await addMut.mutateAsync({ bytes, mime });
      toast.success(i18n.t("novel:scene.toast.imageAdded"));
    } catch (e) {
      toast.error(i18n.t("novel:scene.toast.imageAddFailed"), {
        description: translateError(toErrorPayload(e)),
      });
      // Re-throw so ImageCropDialog keeps its footer active for retry.
      throw e;
    }
  }

  async function handleDelete(imageId: SceneImageMeta["id"]) {
    try {
      await deleteMut.mutateAsync(imageId);
      toast.success(i18n.t("novel:scene.toast.imageRemoved"));
    } catch (e) {
      toast.error(i18n.t("novel:scene.toast.imageRemoveFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIndex = displayImages.findIndex((m) => m.id === active.id);
    const newIndex = displayImages.findIndex((m) => m.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(displayImages, oldIndex, newIndex);
    // Optimistic: reorder the DOM now, sync the server, rollback on failure.
    setOrderOverride(reordered);
    reorderMut
      .mutateAsync(reordered.map((m) => m.id))
      .catch((e) => {
        setOrderOverride(null);
        toast.error(i18n.t("novel:scene.toast.imageReorderFailed"), {
          description: translateError(toErrorPayload(e)),
        });
      });
  }

  // Read mode renders nothing when empty — no empty states in prose reading.
  if (!isEdit && displayImages.length === 0) return null;

  const gridClassName = "grid grid-cols-3 gap-2 sm:grid-cols-4";

  const sortableItems = displayImages.map((m) => m.id as string);

  return (
    <div className={cn(isEdit && "border-t px-4 py-3", !isEdit && "mt-4")}>
      {isEdit && (
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-medium">{t("novel:scene.images.title")}</h4>
          {displayImages.length === 0 && (
            <span className="text-xs text-muted-foreground">
              {t("novel:scene.images.empty")}
            </span>
          )}
        </div>
      )}

      {isEdit ? (
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          onDragEnd={handleDragEnd}
        >
          <SortableContext items={sortableItems} strategy={rectSortingStrategy}>
            <div className={gridClassName}>
              {displayImages.map((meta, i) => (
                <SortableThumb
                  key={meta.id as string}
                  meta={meta}
                  spaceId={spaceId}
                  worldId={worldId}
                  disabled={addMut.isPending || deleteMut.isPending || reorderMut.isPending}
                  onOpen={() => openLightbox(i)}
                  onDelete={() => handleDelete(meta.id)}
                />
              ))}
              <AddTile
                disabled={addMut.isPending}
                onClick={() => setCropOpen(true)}
                label={t("novel:scene.images.add")}
              />
            </div>
          </SortableContext>
        </DndContext>
      ) : (
        <div className={gridClassName}>
          {displayImages.map((meta, i) => (
            <ReadThumb
              key={meta.id as string}
              meta={meta}
              spaceId={spaceId}
              worldId={worldId}
              onOpen={() => openLightbox(i)}
            />
          ))}
        </div>
      )}

      <ImageCropDialog
        open={cropOpen}
        onOpenChange={setCropOpen}
        aspect={CROP_ASPECT}
        outputWidth={CROP_OUTPUT_WIDTH}
        outputHeight={CROP_OUTPUT_HEIGHT}
        title={t("novel:scene.images.add")}
        onSubmit={handleUpload}
      />

      {lightboxIndex !== null && displayImages.length > 0 && (
        <SceneImageLightbox
          open
          onOpenChange={(o) => {
            if (!o) setLightboxIndex(null);
          }}
          images={displayImages}
          index={Math.min(lightboxIndex, displayImages.length - 1)}
          onIndexChange={setLightboxIndex}
          spaceId={spaceId}
          worldId={worldId}
        />
      )}
    </div>
  );
}

// ─── Thumbnail tiles ─────────────────────────────────────────────────────────

interface ThumbCoreProps {
  meta: SceneImageMeta;
  spaceId: string;
  worldId: WorldId;
}

/**
 * Bytes → blob URL → `<img>`. Rendered identically in both modes; the
 * surrounding tile (sortable / read) supplies the interactive chrome.
 */
function ThumbImage({ meta, spaceId, worldId }: ThumbCoreProps) {
  const { data: bytes } = useSceneImageBytes(spaceId, worldId, meta.id);
  const url = useBlobUrl(bytes);
  return (
    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-md bg-muted/40">
      {url ? (
        <img
          src={url}
          alt=""
          loading="lazy"
          className="h-full w-full object-cover"
        />
      ) : (
        <div className="h-full w-full animate-pulse bg-muted/60" aria-hidden="true" />
      )}
    </div>
  );
}

interface ReadThumbProps extends ThumbCoreProps {
  onOpen: () => void;
}

/** Read-mode tile: static, click-to-open. No controls. */
function ReadThumb({ meta, spaceId, worldId, onOpen }: ReadThumbProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="group block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      aria-label={i18n.t("novel:scene.images.open")}
    >
      <ThumbImage meta={meta} spaceId={spaceId} worldId={worldId} />
    </button>
  );
}

interface SortableThumbProps extends ThumbCoreProps {
  disabled: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

/** Edit-mode tile: sortable, with drag handle + delete overlay. */
function SortableThumb({
  meta,
  spaceId,
  worldId,
  disabled,
  onOpen,
  onDelete,
}: SortableThumbProps) {
  const { t } = useTranslation(["novel"]);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: meta.id as string });

  const style: React.CSSProperties = {
    transform: transform
      ? `translate3d(${transform.x}px, ${transform.y}px, 0)`
      : undefined,
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group relative",
        isDragging && "z-10 opacity-70",
        disabled && "pointer-events-none",
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        className="block w-full cursor-zoom-in rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
        aria-label={i18n.t("novel:scene.images.open")}
      >
        <ThumbImage meta={meta} spaceId={spaceId} worldId={worldId} />
      </button>

      {/* Drag handle — only this surface starts a reorder drag. It is a
          sibling of the image button, so its pointer/click events never
          reach the open-lightbox handler (and vice versa). */}
      <span
        {...attributes}
        {...listeners}
        aria-label={t("novel:scene.images.dragHandle")}
        className="absolute left-1 top-1 flex size-6 cursor-grab items-center justify-center rounded-sm bg-black/50 text-white opacity-0 transition-opacity hover:bg-black/70 group-hover:opacity-100 active:cursor-grabbing focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <HugeiconsIcon icon={GripVerticalIcon} strokeWidth={2} className="size-3.5" />
      </span>

      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        aria-label={t("novel:scene.images.delete")}
        className="absolute right-1 top-1 flex size-6 items-center justify-center rounded-sm bg-black/50 text-white opacity-0 transition-opacity hover:bg-destructive group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
      >
        <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} className="size-3.5" />
      </button>
    </div>
  );
}

interface AddTileProps {
  disabled: boolean;
  onClick: () => void;
  label: string;
}

/** Dashed "+" tile appended to the grid; opens the crop dialog. */
function AddTile({ disabled, onClick, label }: AddTileProps) {
  return (
    <Button
      type="button"
      variant="outline"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      // h-auto cancels Button's default fixed height so aspect-square drives
      // the tile to match the thumbnail squares next to it.
      className="h-auto aspect-square w-full border-dashed text-muted-foreground hover:text-foreground"
    >
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-5" />
    </Button>
  );
}
