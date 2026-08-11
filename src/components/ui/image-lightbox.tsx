import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Generic single-image lightbox.
 *
 * The caller owns the blob URL (typically via `useEntityImageBytes` +
 * `useBlobUrl`) and the open state. This component is purely presentational —
 * a near-fullscreen dark Dialog surface with `object-contain` so the image
 * scales without cropping.
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
        showCloseButton
        className="grid gap-0 overflow-hidden bg-background/95 p-0 sm:max-w-5xl"
      >
        <DialogTitle className="sr-only">
          {t("common:lightbox.imagePreview")}
        </DialogTitle>

        <div className="flex items-center justify-center bg-black/90 p-2">
          <div className="flex min-h-[40vh] w-full items-center justify-center">
            {src ? (
              <img
                src={src}
                alt={alt ?? ""}
                className="max-h-[85vh] max-w-full object-contain"
              />
            ) : (
              <div
                className="flex h-64 w-64 animate-pulse items-center justify-center rounded-md bg-muted/20"
                aria-hidden="true"
              />
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
