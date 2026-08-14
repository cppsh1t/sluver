import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowLeft02Icon, ArrowRight02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";
import { arrayBufferToBlobUrl } from "@/lib/image-bytes";
import { useSceneImageBytes } from "@/hooks";
import { cn } from "@/lib/utils";
import type { SceneImageMeta, WorldId } from "@/types";

/**
 * Memoize a blob object URL for a chunk of image bytes and revoke it on
 * change / unmount. Re-creating the URL in the render body (e.g.
 * `src={arrayBufferToBlobUrl(bytes)}`) leaks a blob per render; this hook
 * issues exactly one URL per distinct `ArrayBuffer` reference and frees it
 * when the bytes change or the component unmounts.
 *
 * Returns `null` while `data` is `null`/`undefined` (no image / still loading).
 */
export function useBlobUrl(data: ArrayBuffer | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data) {
      setUrl(null);
      return;
    }
    const created = arrayBufferToBlobUrl(data);
    setUrl(created);
    return () => {
      URL.revokeObjectURL(created);
    };
  }, [data]);
  return url;
}

interface SceneImageLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Full ordered image list (the lightbox cycles through it). */
  images: SceneImageMeta[];
  /** Index into `images` currently on display. */
  index: number;
  onIndexChange: (index: number) => void;
  spaceId: string;
  worldId: WorldId;
}

/**
 * Full-screen-ish lightbox for a scene's images.
 *
 * Fetches the bytes for the currently-focused image via {@link
 * useSceneImageBytes} (shares the React Query cache with the gallery
 * thumbnails, so already-viewed thumbs resolve instantly). Cycles through
 * the list with prev/next arrows + keyboard ←/→. Closes on Escape /
 * backdrop click / the inherited close button (all provided by the Dialog
 * primitive).
 */
export function SceneImageLightbox({
  open,
  onOpenChange,
  images,
  index,
  onIndexChange,
  spaceId,
  worldId,
}: SceneImageLightboxProps) {
  const { t } = useTranslation(["novel", "common"]);
  const current = images[index];
  const { data: bytes, isLoading } = useSceneImageBytes(
    spaceId,
    worldId,
    current?.id,
  );
  const url = useBlobUrl(bytes);

  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  // Keyboard navigation while open. Escape is handled by the Dialog
  // primitive itself; we only own arrow-left / arrow-right.
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "ArrowLeft" && index > 0) {
        e.preventDefault();
        onIndexChange(index - 1);
      } else if (e.key === "ArrowRight" && index < images.length - 1) {
        e.preventDefault();
        onIndexChange(index + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, index, images.length, onIndexChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Frameless popup: the image floats on the dialog's blurred backdrop
        // with no panel around it.
        showCloseButton={false}
        className="grid gap-0 overflow-hidden rounded-none bg-transparent p-0 ring-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">
          {t("novel:scene.images.lightboxTitle")}
        </DialogTitle>

        <DialogClose
          render={
            <button
              type="button"
              aria-label={t("common:actions.close")}
              className="absolute right-3 top-3 z-10 flex size-9 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/50"
            />
          }
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-5" />
        </DialogClose>

        <div className="relative flex items-center justify-center">
          {/* Image stage — bounded so prev/next arrows sit clear of the art. */}
          <div className="flex min-h-[40vh] w-full items-center justify-center">
            {url ? (
              <img
                src={url}
                alt=""
                className="max-h-[78vh] max-w-full object-contain"
              />
            ) : (
              <div
                className={cn(
                  "flex h-64 w-64 items-center justify-center rounded-md bg-white/10",
                  isLoading && "animate-pulse",
                )}
                aria-hidden="true"
              />
            )}
          </div>

          {/* Prev / next controls. Rendered always (when applicable) so the
              layout doesn't shift as the user navigates the list edges. */}
          {hasPrev && (
            <button
              type="button"
              onClick={() => onIndexChange(index - 1)}
              aria-label={t("novel:scene.images.prev")}
              className="absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <HugeiconsIcon icon={ArrowLeft02Icon} strokeWidth={2} className="size-5" />
            </button>
          )}
          {hasNext && (
            <button
              type="button"
              onClick={() => onIndexChange(index + 1)}
              aria-label={t("novel:scene.images.next")}
              className="absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full bg-black/50 text-white transition-colors hover:bg-black/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            >
              <HugeiconsIcon icon={ArrowRight02Icon} strokeWidth={2} className="size-5" />
            </button>
          )}
        </div>

        {/* Position counter — only meaningful when there's more than one. */}
        {images.length > 1 && (
          <div className="mt-2 rounded-full bg-black/50 px-3 py-1 text-xs text-white/80 backdrop-blur-sm">
            {t("novel:scene.images.counter", {
              current: index + 1,
              total: images.length,
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
