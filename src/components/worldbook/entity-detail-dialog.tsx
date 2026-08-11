import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  BookOpen02Icon,
  Calendar03Icon,
  Delete02Icon,
  MapPinIcon,
  Package02Icon,
  PencilEdit01Icon,
  ZoomIcon,
} from "@hugeicons/core-free-icons";
import { EntityAvatar } from "@/components/ui/entity-avatar";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import { useBlobUrl } from "@/components/worldbook/scene-image-lightbox";
import { useEntityImageBytes } from "@/hooks";
import { cn } from "@/lib/utils";
import { formatRelativeTime } from "@/lib/format";
import type {
  ItemId,
  LocationId,
  LoreId,
  SpaceId,
  WorldId,
} from "@/types";

const ENTITY_ICONS = {
  location: MapPinIcon,
  item: Package02Icon,
  lore: BookOpen02Icon,
} as const;

type EntityType = "location" | "item" | "lore";

interface EntityDetailDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entityType: EntityType;
  spaceId: string;
  worldId: WorldId;
  id: LocationId | ItemId | LoreId;
  name: string;
  description: string;
  notes: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  onEdit?: () => void;
  onDelete?: () => void;
}

/**
 * Read-only detail dialog for Location / Item / Lore entities.
 *
 * These entities have no dedicated detail route (unlike Character and Event),
 * so clicking their card opens this dialog to surface fields that the card
 * truncates or omits entirely: full `description` (no `line-clamp`), `notes`,
 * all tags, and both timestamps.
 *
 * The image is clickable — opens an {@link ImageLightbox} for full-size
 * viewing. Uses `useEntityImageBytes` which shares the React Query cache with
 * `EntityAvatar`, so the bytes resolve instantly after the card has already
 * loaded them.
 */
export function EntityDetailDialog({
  open,
  onOpenChange,
  entityType,
  spaceId,
  worldId,
  id,
  name,
  description,
  notes,
  tags,
  createdAt,
  updatedAt,
  onEdit,
  onDelete,
}: EntityDetailDialogProps) {
  const { t } = useTranslation(["worldbook", "common"]);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const Icon = ENTITY_ICONS[entityType];

  // Shares cache with the EntityAvatar below (same query key), so this
  // resolves instantly if the card already loaded the image.
  const { data: imageBytes } = useEntityImageBytes(
    entityType,
    spaceId as SpaceId,
    worldId,
    id,
  );
  const blobUrl = useBlobUrl(imageBytes);
  const hasImage = !!blobUrl;

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          showCloseButton
          className="flex max-h-[85vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
        >
          <DialogTitle className="sr-only">{name}</DialogTitle>

          {/* Scrollable body */}
          <div className="flex flex-1 flex-col overflow-y-auto">
            {/* Image banner — clickable to open the lightbox. The button is
                always rendered but only interactive when there is image data;
                the zoom-in cursor signals clickability. */}
            <button
              type="button"
              disabled={!hasImage}
              onClick={() => hasImage && setLightboxOpen(true)}
              className={cn(
                "group relative block w-full",
                hasImage && "cursor-zoom-in",
              )}
              aria-label={t("worldbook:detail.viewImage")}
            >
              <EntityAvatar
                kind={entityType}
                spaceId={spaceId as SpaceId}
                worldId={worldId}
                id={id}
                alt={name}
                fallbackIcon={
                  <HugeiconsIcon
                    icon={Icon}
                    strokeWidth={2}
                    className="size-16 text-muted-foreground"
                  />
                }
                className="w-full h-48"
              />
              {hasImage && (
                <div className="pointer-events-none absolute bottom-2 right-2 flex size-8 items-center justify-center rounded-full bg-black/50 text-white opacity-0 transition-opacity group-hover:opacity-100">
                  <HugeiconsIcon icon={ZoomIcon} strokeWidth={2} className="size-4" />
                </div>
              )}
            </button>

            {/* Content */}
            <div className="flex flex-col gap-4 p-4">
              {/* Name + actions */}
              <div className="flex items-start justify-between gap-2">
                <h2 className="font-heading text-lg font-semibold">{name}</h2>
                <div className="flex shrink-0 gap-1">
                  {onEdit && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onOpenChange(false);
                        onEdit();
                      }}
                    >
                      <HugeiconsIcon
                        icon={PencilEdit01Icon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />
                      {t("common:actions.edit")}
                    </Button>
                  )}
                  {onDelete && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        onOpenChange(false);
                        onDelete();
                      }}
                    >
                      <HugeiconsIcon
                        icon={Delete02Icon}
                        strokeWidth={2}
                        data-icon="inline-start"
                      />
                      {t("common:actions.delete")}
                    </Button>
                  )}
                </div>
              </div>

              {/* Description */}
              {description && (
                <p className="text-sm text-muted-foreground">
                  {description}
                </p>
              )}

              {/* Notes */}
              <section className="flex flex-col gap-1">
                <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                  {t("worldbook:form.notesLabel")}
                </h3>
                {notes ? (
                  <p className="whitespace-pre-wrap text-sm text-muted-foreground">
                    {notes}
                  </p>
                ) : (
                  <p className="text-sm text-muted-foreground/50">
                    {t("worldbook:detail.noNotes")}
                  </p>
                )}
              </section>

              {/* Tags */}
              {tags.length > 0 && (
                <section className="flex flex-col gap-1">
                  <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground/70">
                    {t("worldbook:form.tagsLabel")}
                  </h3>
                  <div className="flex flex-wrap gap-1">
                    {tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Timestamps */}
              <div className="flex items-center gap-4 border-t pt-3 text-xs text-muted-foreground/70">
                <span className="flex items-center gap-1">
                  <HugeiconsIcon icon={Calendar03Icon} strokeWidth={2} className="size-3.5" />
                  {t("worldbook:detail.createdAtLabel")}: {formatRelativeTime(createdAt)}
                </span>
                <span>
                  {t("worldbook:detail.updatedAtLabel")}: {formatRelativeTime(updatedAt)}
                </span>
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {hasImage && (
        <ImageLightbox
          open={lightboxOpen}
          onOpenChange={setLightboxOpen}
          src={blobUrl}
          alt={name}
        />
      )}
    </>
  );
}
