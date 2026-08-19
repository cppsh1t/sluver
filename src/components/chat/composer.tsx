/**
 * Composer — the message input for one conversation.
 *
 * Consumes the runtime hooks for the draft (`useDraft`), staged attachments
 * (`useDraftAttachments`, ADR-0044 §D8), send (`useSend`), abort
 * (`useAbort`), and the running flag (`useConversationView`). Enter sends,
 * Shift+Enter inserts a newline. While a run is in flight the send button
 * becomes a stop button.
 *
 * Attachment entry points (ADR-0044 §D10): attach button (hidden `<input
 * type="file" multiple>`), paste (`clipboardData.files`), and drag-drop onto
 * the composer container. All three funnel through
 * `filesToDraftAttachments` (pre-validation + data-URL staging) →
 * `addAttachments`; rejected files surface as toasts.
 *
 * On send the composer clears the draft, notifies the parent via
 * `onUserSent(text, attachments)` so the view can render an optimistic echo
 * (the runtime appends the user message to the Agent thread immediately, but
 * `view.messages` only refreshes on run finalization), then hands the built
 * SDK `UserContent` parts array to `send` — text part first (when
 * non-empty), one `FilePart` per staged attachment. The store clears the
 * staged attachments inside its `send`.
 */

import {
  useCallback,
  useRef,
  useState,
  useTransition,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import type { FilePart, TextPart, UserContent } from "ai";

import { HugeiconsIcon } from "@hugeicons/react";
import {
  Attachment02Icon,
  Cancel01Icon,
  File02Icon,
  Sent02Icon,
  StopCircleIcon,
} from "@hugeicons/core-free-icons";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import i18n from "@/i18n";
import {
  useAbort,
  useConversationView,
  useDraft,
  useDraftAttachments,
  useSend,
  type DraftAttachment,
} from "@/lib/conversation-runtime";
import {
  filesToDraftAttachments,
  formatAttachmentSize,
  type AttachmentRejectionReason,
} from "@/lib/conversation-runtime/attachment-picker";
import { cn } from "@/lib/utils";
import type { ConversationId, WorldId } from "@/types";

import { VisionOffBadge } from "./attachment-strip";

interface ComposerProps {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  /**
   * Called with the just-sent text + attachments (the optimistic echo
   * payload — plan D7) so the view can echo them while the run is in
   * flight.
   */
  readonly onUserSent: (
    text: string,
    attachments: readonly DraftAttachment[],
  ) => void;
  /**
   * The currently-bound model is catalog-confirmed to lack image input
   * (plan D9 step 4) — staged image chips get the quiet "not delivered"
   * badge. Computed by the route from the same catalog join the runtime
   * uses per-send.
   */
  readonly imageDeliveryDisabled: boolean;
  /** Optional content rendered at the left of the input row, inside the
   * bordered container (e.g. the context-occupancy readout). Renders
   * `null` = no prefix, no extra gap. */
  readonly prefix?: ReactNode;
}

/** `<input accept>` hint shared by the attach button. */
const ATTACH_ACCEPT =
  "image/png,image/jpeg,image/webp,.txt,.md,.markdown,.csv";

export function Composer({
  worldId,
  conversationId,
  onUserSent,
  imageDeliveryDisabled,
  prefix,
}: ComposerProps) {
  const { t } = useTranslation("chat");
  const [draft, setDraft] = useDraft(worldId, conversationId);
  const {
    draftAttachments,
    addAttachments,
    removeAttachment,
    maxAttachments,
  } = useDraftAttachments(worldId, conversationId);
  const send = useSend(worldId);
  const abort = useAbort(worldId);
  const { view } = useConversationView(worldId, conversationId);
  const isRunning = view.isRunning;

  // Wrap send in a transition so the input stays responsive while the store
  // kicks off the (async) run; the optimistic echo is set synchronously.
  const [pending, startTransition] = useTransition();
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const trimmed = draft.trim();
  const canSend =
    (trimmed.length > 0 || draftAttachments.length > 0) &&
    !isRunning &&
    !pending;

  /** Toast one rejected file (async callback → global `i18n.t`). */
  const toastRejection = useCallback(
    (reason: AttachmentRejectionReason, filename: string) => {
      switch (reason) {
        case "too-many":
          toast.error(
            i18n.t("chat:attachment.tooMany", { max: maxAttachments }),
            { description: filename },
          );
          break;
        case "too-large":
          toast.error(i18n.t("chat:attachment.tooLarge"), {
            description: filename,
          });
          break;
        case "read-failed":
          toast.error(i18n.t("chat:attachment.readFailed"), {
            description: filename,
          });
          break;
        case "invalid-text":
          toast.error(i18n.t("chat:attachment.invalidText", { name: filename }));
          break;
        default:
          toast.error(i18n.t("chat:attachment.unsupportedType"), {
            description: filename,
          });
      }
    },
    [maxAttachments],
  );

  /** Shared pick pipeline: validate → stage accepted → toast rejected. */
  const handleFiles = useCallback(
    (files: FileList | File[]) => {
      const remaining = maxAttachments - draftAttachments.length;
      void filesToDraftAttachments(files, remaining).then(
        ({ accepted, rejected }) => {
          if (accepted.length > 0) addAttachments(accepted);
          for (const { file, reason } of rejected) {
            toastRejection(reason, file.name);
          }
          // Conversion is never silent (ADR-0044): one info toast per
          // converted file, naming the legacy encoding it came from.
          for (const a of accepted) {
            if (a.convertedFrom) {
              toast.info(
                i18n.t("chat:attachment.convertedToUtf8", {
                  name: a.filename,
                  encoding: a.convertedFrom,
                }),
              );
            }
          }
        },
      );
    },
    [maxAttachments, draftAttachments.length, addAttachments, toastRejection],
  );

  const handleSend = useCallback(() => {
    if (!canSend) return;
    const text = trimmed;
    const attachments = draftAttachments; // snapshot before the store clears
    setDraft("");
    onUserSent(text, attachments);
    // Build the SDK UserContent: plain string when attachment-free (the
    // historical path), otherwise text part first + one FilePart each.
    let content: UserContent;
    if (attachments.length === 0) {
      content = text;
    } else {
      const parts: Array<TextPart | FilePart> = [];
      if (text.length > 0) parts.push({ type: "text", text });
      for (const a of attachments) {
        parts.push({
          type: "file",
          data: a.dataUrl,
          mediaType: a.mime,
          filename: a.filename,
        });
      }
      content = parts;
    }
    startTransition(async () => {
      await send(conversationId, content);
    });
  }, [
    canSend,
    trimmed,
    draftAttachments,
    setDraft,
    onUserSent,
    send,
    conversationId,
  ]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter sends; Shift+Enter (or IME composition) inserts a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    // Pasted files (e.g. screenshots) stage as attachments; plain-text
    // paste flows through untouched. preventDefault ONLY when files were
    // consumed so normal text paste keeps working.
    const files = e.clipboardData?.files;
    if (files && files.length > 0) {
      e.preventDefault();
      handleFiles(files);
    }
  };

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    // Only intercept FILE drags — preventDefault here for anything else
    // would break native text drag-drop insertion into the textarea.
    // preventDefault on dragover IS required for the subsequent drop event
    // to fire, so keep it for file drags.
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDragging(true);
  };

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // Only clear when actually leaving the container — not when the pointer
    // crosses between child elements (relatedTarget inside = internal move).
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
      setDragging(false);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false);
    if (e.dataTransfer.files.length === 0) return; // text drop → native insert
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const onInputChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) handleFiles(e.target.files);
    // Reset so picking the SAME file again re-fires onChange.
    e.target.value = "";
  };

  const removeLabel = t("chat:composer.removeAttachment");

  return (
    <div className="border-t border-border bg-background/80 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl px-4 py-3">
        {/* `prefix` (context-occupancy readout) is absolutely positioned in
            the LEFT GUTTER of the centered input box — `right-full` places
            its right edge at the input box's left edge, fully out of flow
            so the input box keeps its full width. `bottom-1.5` aligns the
            readout near the textarea baseline; `pr-2` is the gap. On narrow
            viewports where the gutter collapses the readout overflows left
            (acceptable — it's secondary metadata). */}
        <div className="relative">
          {prefix ? (
            <div className="absolute bottom-1.5 right-full pr-2">{prefix}</div>
          ) : null}
          <div
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            className={cn(
              "flex flex-col rounded-xl border border-input bg-input/20 px-2 py-1.5",
              "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
              dragging && "border-primary/60 bg-primary/5 ring-2 ring-ring/20",
            )}
          >
            {draftAttachments.length > 0 && (
              <div
                role="list"
                aria-label={t("chat:composer.attach")}
                className="flex flex-wrap gap-1.5 pb-1.5"
              >
                {draftAttachments.map((a) =>
                  a.kind === "image" ? (
                    <div key={a.id} role="listitem" className="group/att relative">
                      <img
                        src={a.dataUrl}
                        alt={t("chat:attachment.imageAlt")}
                        draggable={false}
                        className="size-12 rounded-lg object-cover ring-1 ring-border"
                      />
                      {imageDeliveryDisabled && <VisionOffBadge />}
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        aria-label={removeLabel}
                        className={cn(
                          "absolute -right-1.5 -top-1.5 flex size-4.5 items-center justify-center rounded-full",
                          "bg-background text-muted-foreground ring-1 ring-border",
                          "opacity-0 transition-opacity focus-visible:opacity-100 group-hover/att:opacity-100",
                        )}
                      >
                        <HugeiconsIcon
                          icon={Cancel01Icon}
                          strokeWidth={2}
                          className="size-3"
                        />
                      </button>
                    </div>
                  ) : (
                    <div
                      key={a.id}
                      role="listitem"
                      className="group/att relative flex items-center gap-1.5 rounded-lg border border-border bg-background/60 py-1 pr-2.5 pl-2 text-xs"
                    >
                      <HugeiconsIcon
                        icon={File02Icon}
                        strokeWidth={2}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <Tooltip>
                        <TooltipTrigger render={<span className="max-w-40 truncate" />}>
                          {t("chat:attachment.textChip", {
                            name: a.filename,
                            size: formatAttachmentSize(a.sizeBytes),
                          })}
                        </TooltipTrigger>
                        <TooltipContent>{a.filename}</TooltipContent>
                      </Tooltip>
                      <button
                        type="button"
                        onClick={() => removeAttachment(a.id)}
                        aria-label={removeLabel}
                        className={cn(
                          "flex size-4 items-center justify-center rounded-full text-muted-foreground",
                          "transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                        )}
                      >
                        <HugeiconsIcon
                          icon={Cancel01Icon}
                          strokeWidth={2}
                          className="size-3"
                        />
                      </button>
                    </div>
                  ),
                )}
              </div>
            )}
            <div className="flex items-end gap-2">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                accept={ATTACH_ACCEPT}
                onChange={onInputChange}
              />
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      onClick={() => fileInputRef.current?.click()}
                      aria-label={t("chat:composer.attach")}
                      disabled={
                        draftAttachments.length >= maxAttachments || isRunning
                      }
                    />
                  }
                >
                  <HugeiconsIcon icon={Attachment02Icon} strokeWidth={2} />
                </TooltipTrigger>
                <TooltipContent>{t("chat:composer.attach")}</TooltipContent>
              </Tooltip>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={onKeyDown}
                onPaste={onPaste}
                placeholder={t("chat:composer.placeholder")}
                rows={1}
                aria-label={t("chat:composer.placeholder")}
                className="max-h-40 min-h-[1.5rem] flex-1 resize-none border-0 bg-transparent px-1 shadow-none focus-visible:border-0 focus-visible:ring-0 dark:bg-transparent"
              />
              {isRunning ? (
                <Button
                  variant="outline"
                  size="icon"
                  onClick={() => abort(conversationId)}
                  aria-label={t("chat:composer.stop")}
                >
                  <HugeiconsIcon icon={StopCircleIcon} strokeWidth={2} />
                </Button>
              ) : (
                <Button
                  size="icon"
                  onClick={handleSend}
                  disabled={!canSend}
                  aria-label={t("chat:composer.send")}
                >
                  <HugeiconsIcon icon={Sent02Icon} strokeWidth={2} />
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
