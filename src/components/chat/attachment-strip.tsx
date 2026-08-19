/**
 * Attachment strip (ADR-0044 §D5) — the read-only attachment row rendered on
 * user messages in the conversation history (persisted + optimistic echo).
 *
 * Renders from the hydrated data URLs already present on the message
 * (no second fetch layer — plan D5):
 * - image attachments → thumbnails; click opens {@link ImageLightbox};
 * - text attachments → file chips; click opens a monospace preview dialog
 *   (first {@link PREVIEW_CHAR_LIMIT} chars, decoded client-side);
 * - when the currently-bound model lacks vision (plan D9 step 4), image
 *   thumbnails carry a quiet "not delivered" badge so users understand why
 *   the model ignores their images.
 *
 * The composer's editable chip strip (remove buttons, staging) is separate —
 * see `composer.tsx`.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { File02Icon, ViewOffIcon } from "@hugeicons/core-free-icons";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ImageLightbox } from "@/components/ui/image-lightbox";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  decodeDataUrlText,
  formatAttachmentSize,
} from "@/lib/conversation-runtime/attachment-picker";
import { cn } from "@/lib/utils";

import type { AttachmentBlockItem } from "./message-render";

/** Text preview truncation (chars) — a full read in a dialog is fine at 2k. */
const PREVIEW_CHAR_LIMIT = 2000;

export interface AttachmentStripProps {
  readonly attachments: readonly AttachmentBlockItem[];
  /**
   * The currently-bound model is catalog-confirmed to lack image input
   * (plan D9 step 4) — image thumbnails get the "not delivered" badge.
   */
  readonly imageDeliveryDisabled: boolean;
  /** Layout alignment — the history strip right-aligns under the bubble. */
  readonly className?: string;
}

/**
 * Quiet corner badge marking an image the model will not receive. Tooltip
 * explains why (i18n `chat:attachment.notDelivered`).
 */
export function VisionOffBadge() {
  const { t } = useTranslation("chat");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            aria-label={t("chat:attachment.notDelivered")}
            className={cn(
              "absolute bottom-0.5 right-0.5 flex size-4 items-center justify-center",
              "rounded-full bg-background/85 text-muted-foreground ring-1 ring-border backdrop-blur-sm",
            )}
          />
        }
      >
        <HugeiconsIcon icon={ViewOffIcon} strokeWidth={2} className="size-2.5" />
      </TooltipTrigger>
      <TooltipContent>{t("chat:attachment.notDelivered")}</TooltipContent>
    </Tooltip>
  );
}

/** One image attachment: thumbnail → lightbox, optional not-delivered badge. */
function ImageThumb({
  item,
  onOpen,
  imageDeliveryDisabled,
}: {
  readonly item: AttachmentBlockItem;
  readonly onOpen: () => void;
  readonly imageDeliveryDisabled: boolean;
}) {
  const { t } = useTranslation("chat");
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t("chat:attachment.imageAlt")}
      className="group/img relative size-16 shrink-0 overflow-hidden rounded-xl ring-1 ring-border transition-[filter] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 hover:brightness-105"
    >
      <img
        src={item.dataUrl}
        alt={t("chat:attachment.imageAlt")}
        className="size-full object-cover"
        draggable={false}
      />
      {imageDeliveryDisabled && <VisionOffBadge />}
    </button>
  );
}

/** One text attachment: filename chip → monospace preview dialog. */
function TextChip({
  item,
  onOpen,
}: {
  readonly item: AttachmentBlockItem;
  readonly onOpen: () => void;
}) {
  const { t } = useTranslation("chat");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "flex max-w-[16rem] items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-2 py-1 text-xs text-foreground",
              "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50 hover:bg-muted/70",
            )}
          >
            <HugeiconsIcon
              icon={File02Icon}
              strokeWidth={2}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <span className="truncate">
              {t("chat:attachment.textChip", {
                name: item.filename,
                size: formatAttachmentSize(estimateSize(item.dataUrl)),
              })}
            </span>
          </button>
        }
      />
      <TooltipContent>{item.filename}</TooltipContent>
    </Tooltip>
  );
}

/** Rough byte size from the base64 payload length (display-only). */
function estimateSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  if (comma === -1) return 0;
  const b64 = dataUrl.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export function AttachmentStrip({
  attachments,
  imageDeliveryDisabled,
  className,
}: AttachmentStripProps) {
  const { t } = useTranslation("chat");
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [previewItem, setPreviewItem] = useState<AttachmentBlockItem | null>(
    null,
  );

  const previewText = previewItem
    ? decodeDataUrlText(previewItem.dataUrl)
    : "";
  const truncated = previewText.length > PREVIEW_CHAR_LIMIT;

  return (
    <>
      <div className={cn("flex flex-wrap justify-end gap-1.5", className)}>
        {attachments.map((item, i) =>
          item.kind === "image" ? (
            <ImageThumb
              key={`${item.filename}-${i}`}
              item={item}
              onOpen={() => setLightboxUrl(item.dataUrl)}
              imageDeliveryDisabled={imageDeliveryDisabled}
            />
          ) : (
            <TextChip
              key={`${item.filename}-${i}`}
              item={item}
              onOpen={() => setPreviewItem(item)}
            />
          ),
        )}
      </div>

      <ImageLightbox
        open={lightboxUrl !== null}
        onOpenChange={(open) => {
          if (!open) setLightboxUrl(null);
        }}
        src={lightboxUrl}
        alt={t("chat:attachment.imageAlt")}
      />

      <Dialog
        open={previewItem !== null}
        onOpenChange={(open) => {
          if (!open) setPreviewItem(null);
        }}
      >
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle className="truncate pr-8">
              {previewItem?.filename ?? ""}
            </DialogTitle>
            <DialogDescription>
              {t("chat:attachment.previewTitle")}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-[60vh] overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-all">
            {truncated
              ? previewText.slice(0, PREVIEW_CHAR_LIMIT)
              : previewText}
          </pre>
          {truncated && (
            <p className="text-[0.6875rem] text-muted-foreground">
              {t("chat:attachment.previewTruncated")}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
