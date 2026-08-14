import { useTranslation } from "react-i18next";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon } from "@hugeicons/core-free-icons";

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Generic single-image lightbox.
 *
 * The caller owns the blob URL (typically via `useEntityImageBytes` +
 * `useBlobUrl`) and the open state. This component is purely presentational —
 * the image floats directly on the dialog's blurred backdrop with no panel or
 * frame around it, and a custom close button (the default ghost close button
 * is invisible on a transparent popup over the dark backdrop).
 *
 * For multi-image galleries with prev/next navigation, see
 * `SceneImageLightbox` instead.
 */

export interface ImageLightboxProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Blob URL of the image to display. `null`/`undefined` shows a loading skeleton. */
  src: string | null | undefined;
  alt?: string;
}

export function ImageLightbox({
  open,
  onOpenChange,
  src,
  alt,
}: ImageLightboxProps) {
  const { t } = useTranslation(["common"]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="grid place-items-center gap-0 overflow-hidden rounded-none bg-transparent p-0 ring-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">
          {t("common:lightbox.imagePreview")}
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

        {src ? (
          <img
            src={src}
            alt={alt ?? ""}
            className="max-h-[85vh] max-w-full object-contain"
          />
        ) : (
          <div
            className="size-64 animate-pulse rounded-md bg-white/10"
            aria-hidden="true"
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
