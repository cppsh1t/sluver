/**
 * Per-message actions — the hover-revealed copy / edit / delete row shown on
 * chat message blocks, the inline edit boxes for user messages and assistant
 * text blocks, and the delete-confirmation dialog.
 *
 * Layout rule (CRITICAL): the action row is ALWAYS space-reserved (in-flow,
 * fixed `h-5`) and revealed purely via an opacity transition keyed on the
 * named `group/msg` hover / focus-within — never via display toggling or
 * absolute positioning. Hovering a message therefore cannot shift layout or
 * disturb the pinned-to-bottom auto-scroll in `conversation-view.tsx`
 * (same pattern as the conversation-list rows and composer attachment
 * chips).
 *
 * Visibility rules (see `renderBlock` in conversation-view.tsx):
 * - Tool blocks, reasoning blocks, token footers and step dividers get NO
 *   actions (NOT editable — only assistant TEXT parts are). The optimistic
 *   pending block and currently-streaming text get no row at all
 *   (transient — nothing stable to act on).
 * - While a run is in flight (`view.isRunning`) edit + delete are hidden;
 *   copy stays so finished text remains copyable.
 *
 * Editing is IN-PLACE ONLY: saving persists the new text — NO resend, NO
 * truncation. User edits rewrite the whole message text (`partIndex: null`;
 * attachments are preserved store-side); assistant edits rewrite the single
 * text part addressed by `(messageId, partIndex)`.
 *
 * Runtime hooks (`useDeleteMessage` / `useEditMessage`) come from the
 * binding contract in `@/lib/conversation-runtime`. `useDeleteMessage`
 * rethrows on failure; `useEditMessage` resolves `true` once the edit is
 * persisted (DB first, then memory — `view.messages` refreshes
 * synchronously after the await resolves, so closing the edit box on
 * success shows the edited text immediately) or `false` when a store guard
 * rejected (already logged store-side; nothing changed), and REJECTS on
 * persistence failure (nothing happened anywhere). Every callsite catches,
 * toasts via the GLOBAL `i18n.t` (async-context rule — never the hook `t`),
 * and keeps the UI in its previous state.
 */

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { HugeiconsIcon } from "@hugeicons/react";
import { Copy01Icon, Delete02Icon, PencilEdit01Icon, Tick01Icon } from "@hugeicons/core-free-icons";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toErrorPayload } from "@/api/client";
import i18n from "@/i18n";
import { translateError } from "@/i18n/errors";
import { useDeleteMessage, useEditMessage } from "@/lib/conversation-runtime";
import { cn } from "@/lib/utils";
import type { ConversationId, WorldId } from "@/types";

import { AttachmentStrip } from "./attachment-strip";
import { Markdown } from "./markdown";
import type { AttachmentBlockItem } from "./message-render";

/** How long the copy button shows the check icon after a successful copy. */
const COPY_FEEDBACK_MS = 1500;

/**
 * Blinking block cursor appended to streaming assistant text. Lives here
 * (not in `conversation-view.tsx`) because {@link AssistantTextBlock} owns
 * the streaming text surface — moving it avoids a circular import.
 */
function StreamingCursor() {
  return (
    <span
      aria-hidden
      className="ml-0.5 inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-foreground align-baseline"
    />
  );
}

// ─── Action row ────────────────────────────────────────────────────────────

interface MessageActionsRowProps {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  /** Persisted message id — user blocks carry it directly; assistant text
   * block ids are `${msg.id}#text-${i}` (split on `#` upstream). */
  readonly messageId: string;
  readonly copyText: string;
  /** Render the copy button (hidden for empty-text attachment-only turns). */
  readonly canCopy: boolean;
  /** Edit trigger — user messages and assistant text blocks;
   * `undefined` hides the button. */
  readonly onEdit?: () => void;
  /** Render the delete button (hidden while a run is in flight). */
  readonly canDelete: boolean;
  readonly className?: string;
}

/**
 * Hover-revealed icon row. Must be rendered inside a `group/msg` container —
 * the reveal is `group-hover/msg` / `group-focus-within/msg` opacity so it is
 * keyboard-reachable without a pointer.
 */
function MessageActionsRow({
  worldId,
  conversationId,
  messageId,
  copyText,
  canCopy,
  onEdit,
  canDelete,
  className,
}: MessageActionsRowProps) {
  const { t } = useTranslation(["chat", "common"]);
  const deleteMessage = useDeleteMessage(worldId);

  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Clear any in-flight copy-feedback timer on unmount.
  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    };
  }, []);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(copyText);
      setCopied(true);
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_MS);
    } catch {
      toast.error(i18n.t("chat:toast.copyFailed"));
    }
  }

  async function handleConfirmDelete() {
    setConfirmDelete(false);
    try {
      await deleteMessage(conversationId, messageId);
    } catch (e) {
      toast.error(i18n.t("chat:toast.deleteFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  if (!canCopy && !onEdit && !canDelete) return null;

  const copyLabel = t("chat:message.copy");
  const editLabel = t("chat:message.edit");
  const deleteLabel = t("chat:message.delete");

  return (
    <>
      <div
        className={cn(
          "flex h-5 items-center gap-0.5 opacity-0 transition-opacity",
          "group-hover/msg:opacity-100 group-focus-within/msg:opacity-100",
          className,
        )}
      >
        {canCopy && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => void handleCopy()}
                  aria-label={copyLabel}
                  className="text-muted-foreground hover:text-foreground"
                />
              }
            >
              <HugeiconsIcon icon={copied ? Tick01Icon : Copy01Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>{copyLabel}</TooltipContent>
          </Tooltip>
        )}
        {onEdit && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={onEdit}
                  aria-label={editLabel}
                  className="text-muted-foreground hover:text-foreground"
                />
              }
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>{editLabel}</TooltipContent>
          </Tooltip>
        )}
        {canDelete && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setConfirmDelete(true)}
                  aria-label={deleteLabel}
                  className="text-muted-foreground hover:text-destructive"
                />
              }
            >
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            </TooltipTrigger>
            <TooltipContent>{deleteLabel}</TooltipContent>
          </Tooltip>
        )}
      </div>

      <AlertDialog
        open={confirmDelete}
        onOpenChange={(open) => {
          if (!open) setConfirmDelete(false);
        }}
      >
        <AlertDialogContent size="sm">
          <AlertDialogHeader>
            <AlertDialogTitle>{t("chat:message.deleteTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("chat:message.deleteDesc")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void handleConfirmDelete()}>
              {deleteLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

// ─── Inline edit box ───────────────────────────────────────────────────────

interface MessageEditBoxProps {
  readonly initialText: string;
  readonly onCancel: () => void;
  /**
   * Save the edit (persist in place — no resend). Must NOT reject — the
   * owner catches failures, toasts and keeps the box mounted; resolving
   * closes it only when the edit actually committed (a store-guard no-op
   * keeps the box mounted too).
   */
  readonly onSubmit: (text: string) => Promise<void>;
}

/**
 * Inline editor replacing a user bubble or an assistant text block. Enter
 * submits, Shift+Enter inserts a newline, Escape cancels (same key handling
 * as the composer, including the IME-composition guard). The textarea
 * auto-sizes via native `field-sizing: content` (base Textarea) capped at
 * `max-h-40`.
 */
function MessageEditBox({ initialText, onCancel, onSubmit }: MessageEditBoxProps) {
  const { t } = useTranslation(["chat", "common"]);
  const [draft, setDraft] = useState(initialText);
  const [submitting, setSubmitting] = useState(false);

  const trimmed = draft.trim();
  const canSubmit = trimmed.length > 0 && !submitting;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await onSubmit(trimmed);
    } finally {
      // On success the owner unmounts this box; on failure it stays and
      // the buttons re-enable for a retry.
      setSubmitting(false);
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter submits; Shift+Enter (or IME composition) inserts a newline.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void handleSubmit();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (!submitting) onCancel();
    }
  };

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-1.5 rounded-2xl rounded-br-sm border border-input bg-input/20 px-2 py-1.5",
        "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30",
      )}
    >
      <Textarea
        autoFocus
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        disabled={submitting}
        rows={1}
        aria-label={t("chat:message.edit")}
        className="max-h-40 min-h-[1.5rem] resize-none border-0 bg-transparent px-1 text-sm shadow-none focus-visible:border-0 focus-visible:ring-0 md:text-sm dark:bg-transparent"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={submitting}>
          {t("common:actions.cancel")}
        </Button>
        <Button type="button" size="sm" onClick={() => void handleSubmit()} disabled={!canSubmit}>
          {t("chat:message.save")}
        </Button>
      </div>
    </div>
  );
}

// ─── User message block (bubble + actions + edit mode) ────────────────────

interface UserMessageBlockProps {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  /** Persisted message id (user block ids ARE the message id). */
  readonly messageId: string;
  readonly text: string;
  readonly attachments?: readonly AttachmentBlockItem[];
  readonly optimistic: boolean;
  /** While a run is in flight, edit + delete are hidden (copy stays). */
  readonly isRunning: boolean;
  readonly imageDeliveryDisabled: boolean;
}

/**
 * One user message: attachment strip + right-aligned bubble + hover actions,
 * swappable into an inline edit state. Owns the in-place edit lifecycle —
 * saving persists the whole message text (`partIndex: null`); attachments
 * are preserved store-side.
 */
export function UserMessageBlock({
  worldId,
  conversationId,
  messageId,
  text,
  attachments,
  optimistic,
  isRunning,
  imageDeliveryDisabled,
}: UserMessageBlockProps) {
  const [editing, setEditing] = useState(false);
  const editMessage = useEditMessage(worldId);

  async function handleEditSubmit(newText: string) {
    // In-place persist — no resend, no truncation, no optimistic echo:
    // - `true`  ⇒ edit committed (DB then memory; `view.messages` refreshes
    //   synchronously after the await) — close the edit box, the edited
    //   text is already rendered from the refreshed view.
    // - `false` ⇒ a store guard rejected (already logged store-side): stay
    //   in edit mode, silent, nothing changed.
    // - throws ⇒ persistence failed, nothing happened anywhere: toast and
    //   stay in edit mode.
    try {
      const edited = await editMessage(conversationId, messageId, null, newText);
      if (edited) setEditing(false);
    } catch (e) {
      toast.error(i18n.t("chat:toast.editFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  return (
    <div className="flex justify-end">
      <div
        className={cn(
          "group/msg flex max-w-[85%] flex-col items-end gap-1",
          optimistic && "opacity-90",
        )}
      >
        {attachments && attachments.length > 0 && (
          <AttachmentStrip
            attachments={attachments}
            imageDeliveryDisabled={imageDeliveryDisabled}
          />
        )}
        {editing ? (
          <MessageEditBox
            initialText={text}
            onCancel={() => setEditing(false)}
            onSubmit={handleEditSubmit}
          />
        ) : (
          <>
            {text.length > 0 && (
              <div className="whitespace-pre-wrap rounded-2xl rounded-br-sm bg-primary px-3 py-1.5 text-sm text-primary-foreground">
                {text}
              </div>
            )}
            {!optimistic && (
              <MessageActionsRow
                worldId={worldId}
                conversationId={conversationId}
                messageId={messageId}
                copyText={text}
                canCopy={text.length > 0}
                onEdit={isRunning ? undefined : () => setEditing(true)}
                canDelete={!isRunning}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Assistant text block (markdown + actions + edit mode) ────────────────

interface AssistantTextBlockProps {
  readonly worldId: WorldId;
  readonly conversationId: ConversationId;
  /**
   * Persisted message id — the segment before the `#` in parts-array block
   * ids (`${msg.id}#text-${i}`), or the bare block id for string-content
   * assistant messages.
   */
  readonly messageId: string;
  /**
   * Index of the text part within the assistant message's content array;
   * `null` for string-content assistant messages (the whole message text
   * is the single editable unit).
   */
  readonly partIndex: number | null;
  readonly text: string;
  /** Live-streaming block: cursor shown, NO actions (transient text). */
  readonly streaming: boolean;
  /** While a run is in flight, edit + delete are hidden (copy stays). */
  readonly isRunning: boolean;
  /**
   * Synthetic live-stream block (`__live_text_N__`): NOT a persisted id —
   * never renders actions (an action row targeting the fake id would
   * silently no-op).
   */
  readonly synthetic: boolean;
}

/**
 * One assistant text block: Markdown + streaming cursor + hover actions,
 * swappable into an inline edit state that persists the edited part in
 * place. Per-block editing — tool-call cards and reasoning blocks are NOT
 * editable (they get no actions at all).
 */
export function AssistantTextBlock({
  worldId,
  conversationId,
  messageId,
  partIndex,
  text,
  streaming,
  isRunning,
  synthetic,
}: AssistantTextBlockProps) {
  const [editing, setEditing] = useState(false);
  const editMessage = useEditMessage(worldId);

  async function handleEditSubmit(newText: string) {
    // Same contract as the user-message edit: `true` ⇒ committed (close the
    // box — the refreshed view already carries the edited part), `false` ⇒
    // store guard no-op (stay in edit mode, silent), throws ⇒ persistence
    // failure (toast, stay in edit mode).
    try {
      const edited = await editMessage(conversationId, messageId, partIndex, newText);
      if (edited) setEditing(false);
    } catch (e) {
      toast.error(i18n.t("chat:toast.editFailed"), {
        description: translateError(toErrorPayload(e)),
      });
    }
  }

  return (
    <div className="group/msg flex flex-col gap-1">
      {editing ? (
        <MessageEditBox
          initialText={text}
          onCancel={() => setEditing(false)}
          onSubmit={handleEditSubmit}
        />
      ) : (
        <>
          <Markdown content={text} />
          {streaming && <StreamingCursor />}
          {!streaming && !synthetic && (
            <MessageActionsRow
              worldId={worldId}
              conversationId={conversationId}
              messageId={messageId}
              copyText={text}
              canCopy
              onEdit={isRunning ? undefined : () => setEditing(true)}
              canDelete={!isRunning}
            />
          )}
        </>
      )}
    </div>
  );
}
