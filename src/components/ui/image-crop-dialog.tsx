import { useCallback, useEffect, useRef, useState } from "react";
import Cropper, { type Area } from "react-easy-crop";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { logger } from "@/lib/logger";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Image pick → crop → compress → submit dialog.
 *
 * A reusable primitive used by every entity form (World, Character, Phase,
 * Location, Item, Lore, Event, Novel) to attach a cover/avatar image. The
 * flow is:
 *
 *   1. Pick   — `<input type="file">` validated against an allow-list of
 *               MIME types and a 5 MB client-side guard (the backend re-checks
 *               the post-compress size).
 *   2. Crop   — `react-easy-crop` renders the image at the fixed `aspect`;
 *               the user drags + zooms. `onCropComplete` stashes the absolute
 *               crop rectangle (in source pixels) in a ref.
 *   3. Export — on confirm, the cropped source rectangle is drawn onto a
 *               `outputWidth × outputHeight` canvas and re-encoded as WebP
 *               (quality 0.8) via `canvas.toBlob`.
 *   4. Submit — `onSubmit(bytes, "image/webp")` is awaited with the footer
 *               buttons disabled; success closes the dialog, failure surfaces
 *               inline (the parent decides whether to toast).
 *
 * The component owns no IPC — it only produces bytes. Image storage lives in
 * the entity API layer (`@/api/image`), which is why this stays a pure UI
 * primitive with no knowledge of `kind`/`spaceId`/`worldId`.
 */

export interface ImageCropDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target crop aspect, e.g. `16/9`, `3/4`, `1`. */
  aspect: number;
  /** Target export width in pixels. */
  outputWidth: number;
  /** Target export height in pixels. */
  outputHeight: number;
  /** Dialog header. Defaults to the localized "Edit image". */
  title?: string;
  /** Receives the compressed WebP bytes. Resolves on success, rejects on failure. */
  onSubmit: (bytes: Uint8Array, mime: string) => Promise<void>;
  /** Optional side-channel for errors so the parent can toast/log. */
  onError?: (message: string) => void;
}

/** Accepted input MIME types. Output is WebP (or PNG on WebViews without WebP encoding support). */
const ACCEPTED_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
/** Client-side size guard. The backend enforces its own post-compress limit. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;
/** WebP encode quality handed to `canvas.toBlob`. */
const WEBP_QUALITY = 0.8;

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function ImageCropDialog({
  open,
  onOpenChange,
  aspect,
  outputWidth,
  outputHeight,
  title,
  onSubmit,
  onError,
}: ImageCropDialogProps) {
  const { t } = useTranslation(["common"]);

  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Mirrors `croppedAreaRef.current !== null` as state so the Confirm button
  // can enable reactively. Flips false→true exactly once per image (React
  // bails out of the redundant updates react-easy-crop fires on every drag),
  // so this costs no per-drag re-render.
  const [hasCrop, setHasCrop] = useState(false);

  // Source-pixel crop rectangle captured from react-easy-crop. Kept in a ref
  // because it updates on every drag (high churn) but is only read at confirm
  // time — storing it in state would needlessly re-render the Cropper.
  const croppedAreaRef = useRef<Area | null>(null);
  // Tracks the live object URL for the picked file so we can revoke it on
  // replacement / close / unmount (ADR: no implicit blob URL leaks).
  const objectUrlRef = useRef<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const revokeObjectUrl = useCallback(() => {
    if (objectUrlRef.current !== null) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
  }, []);

  // Full reset whenever the dialog closes. Runs on unmount too, so a close
  // during submit (rare, but possible via ESC) still frees the object URL.
  useEffect(() => {
    if (open) return;
    setImageSrc(null);
    setCrop({ x: 0, y: 0 });
    setZoom(1);
    setError(null);
    setSubmitting(false);
    setHasCrop(false);
    croppedAreaRef.current = null;
    revokeObjectUrl();
  }, [open, revokeObjectUrl]);

  const reportError = useCallback(
    (message: string) => {
      setError(message);
      onError?.(message);
    },
    [onError],
  );

  const handleFileChange = useCallback(
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Always clear the input value so picking the same file twice fires
      // `change` both times (native inputs otherwise suppress re-pick).
      event.target.value = "";
      if (!file) return;

      if (!ACCEPTED_MIME.includes(file.type as (typeof ACCEPTED_MIME)[number])) {
        reportError(t("common:imageEditor.invalidFile"));
        return;
      }
      if (file.size > MAX_FILE_BYTES) {
        reportError(t("common:imageEditor.fileTooLarge", { size: formatBytes(file.size) }));
        return;
      }

      revokeObjectUrl();
      const url = URL.createObjectURL(file);
      objectUrlRef.current = url;
      croppedAreaRef.current = null;
      setHasCrop(false);
      setCrop({ x: 0, y: 0 });
      setZoom(1);
      setError(null);
      setImageSrc(url);
    },
    [revokeObjectUrl, reportError, t],
  );

  const handleCropComplete = useCallback((_: Area, croppedAreaPixels: Area) => {
    croppedAreaRef.current = croppedAreaPixels;
    setHasCrop(true);
  }, []);

  const handleConfirm = useCallback(async () => {
    const src = imageSrc;
    const area = croppedAreaRef.current;
    if (!src || !area) return;

    setSubmitting(true);
    setError(null);
    try {
      // Decode the picked file. `img.decode()` rejects on corrupt input —
      // surface a friendly error instead of letting it throw mid-canvas.
      const img = new Image();
      img.src = src;
      await img.decode();

      const canvas = document.createElement("canvas");
      canvas.width = outputWidth;
      canvas.height = outputHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reportError(t("common:imageEditor.submitFailed"));
        logger.error("image_crop.canvas_context_unavailable", {
          output_width: outputWidth,
          output_height: outputHeight,
        });
        return;
      }
      // Draw the source crop rectangle scaled to the exact export dimensions.
      ctx.drawImage(
        img,
        area.x,
        area.y,
        area.width,
        area.height,
        0,
        0,
        outputWidth,
        outputHeight,
      );

      const blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, "image/webp", WEBP_QUALITY),
      );
      if (!blob) {
        reportError(t("common:imageEditor.submitFailed"));
        logger.warn("image_crop.to_blob_returned_null", {
          output_width: outputWidth,
          output_height: outputHeight,
        });
        return;
      }

      const buf = await blob.arrayBuffer();
      const bytes = new Uint8Array(buf);
      // Use the Canvas output's actual type — `toBlob("image/webp")` silently
      // falls back to PNG on Safari/WebKitGTK (which don't support WebP
      // encoding), so `blob.type` is the only reliable signal of what bytes
      // were actually produced.
      await onSubmit(bytes, blob.type || "image/webp");
      // Success — hand control back to the parent, which flips `open` to
      // false (and triggers the reset effect above).
      onOpenChange(false);
    } catch (e) {
      // Distinguish decode failures (user picked a corrupt/odd file) from
      // submit failures (IPC rejected). Both stay inline; the parent gets
      // the message via `onError` if it wants to toast.
      const message =
        e instanceof DOMException && e.name === "EncodingError"
          ? t("common:imageEditor.loadFailed")
          : t("common:imageEditor.submitFailed");
      reportError(message);
      logger.warn("image_crop.submit_failed", { error: String(e) });
    } finally {
      setSubmitting(false);
    }
  }, [
    imageSrc,
    outputWidth,
    outputHeight,
    onSubmit,
    onOpenChange,
    reportError,
    t,
  ]);

  const triggerFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const hasImage = imageSrc !== null;
  const confirmLabel = submitting
    ? t("common:imageEditor.uploading")
    : t("common:imageEditor.confirm");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title ?? t("common:imageEditor.title")}</DialogTitle>
          <DialogDescription>{t("common:imageEditor.description")}</DialogDescription>
        </DialogHeader>

        {/* Hidden native file input — triggered imperatively so the visible
            trigger can be a styled Button without nesting an <input>. */}
        <input
          ref={fileInputRef}
          type="file"
          accept={ACCEPTED_MIME.join(",")}
          className="sr-only"
          onChange={handleFileChange}
        />

        {hasImage ? (
          <div className="flex flex-col gap-3">
            {/* Cropper needs an explicit-height positioning context; it
                absolutely positions its internals inside this box. */}
            <div className="relative h-64 w-full overflow-hidden rounded-md bg-muted">
              <Cropper
                image={imageSrc as string}
                crop={crop}
                zoom={zoom}
                aspect={aspect}
                onCropChange={setCrop}
                onZoomChange={setZoom}
                onCropComplete={handleCropComplete}
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-xs/relaxed text-muted-foreground">
                {t("common:imageEditor.zoom")}
              </span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.1}
                value={zoom}
                aria-label={t("common:imageEditor.zoom")}
                onChange={(e) => setZoom(Number(e.target.value))}
                // Native range is the dependency-free, accessible choice — the
                // project has no Slider primitive and the spec forbids extra
                // packages. `accent-primary` maps to --color-primary (theme).
                className="h-1 flex-1 cursor-pointer accent-primary"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-3 rounded-md border border-dashed p-6 text-center">
            <p className="text-xs/relaxed text-muted-foreground">
              {t("common:imageEditor.acceptedFormats")}
            </p>
            <Button variant="outline" onClick={triggerFilePicker}>
              {t("common:imageEditor.chooseFile")}
            </Button>
          </div>
        )}

        <DialogFooter
          className={cn(
            // Inline error slots in above the action row so failures are
            // visible without stealing focus or spawning a toast.
            "items-start gap-2",
            error && "sm:items-center",
          )}
        >
          {error && (
            <p
              role="alert"
              className="flex-1 text-left text-xs/relaxed text-destructive sm:text-right"
            >
              {error}
            </p>
          )}
          {hasImage && (
            <Button variant="ghost" onClick={triggerFilePicker} disabled={submitting}>
              {t("common:imageEditor.changeFile")}
            </Button>
          )}
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={submitting}
          >
            {t("common:actions.cancel")}
          </Button>
          {hasImage && (
            <Button onClick={handleConfirm} disabled={submitting || !hasCrop}>
              {confirmLabel}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
