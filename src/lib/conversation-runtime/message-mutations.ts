/**
 * Pure helpers for user-initiated message mutations (ADR-0047).
 *
 * Two pure functions over the reactive view's `SessionMessage[]`:
 *
 * - {@link expandDeleteIds} — single-message delete: which rows must go so
 *   the surviving thread never carries a dangling half of a tool pair (an
 *   assistant `tool-call` without its `tool-result`, or vice versa). Every
 *   provider requires tool results to follow their calls, so a dangling
 *   half would make the NEXT run's model input invalid.
 * - {@link replaceMessageText} — in-place body edit: builds the replacement
 *   message with its text content swapped for the edited text, leaving all
 *   other parts (tool calls, reasoning, files) untouched.
 *
 * Part parsing mirrors the defensive narrowing of the render layer
 * (`src/components/chat/message-render.tsx`) and the Agent's `findToolPair`
 * scan — duplicated here as narrow local code because lib/ must not import
 * from components/ (ADR-0019 layering).
 *
 * Related: ADR-0028 (Persisted Thread — append-only relaxed for
 * user-initiated mutations, durable-first), ADR-0047.
 */

import type { SessionMessage } from "@/lib/ai";

// ─── Part parsing (defensive, mirrors findToolPair / message-render) ──────

/**
 * The `toolCallId`s carried by an assistant message's `tool-call` parts.
 * Empty for string content / messages with no tool calls.
 */
function assistantToolCallIds(message: SessionMessage): string[] {
  if (message.role !== "assistant") return [];
  const { content } = message;
  if (typeof content === "string" || !Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (part.type === "tool-call") ids.push(part.toolCallId);
  }
  return ids;
}

/**
 * The `toolCallId`s answered by a tool message's `tool-result` parts.
 * Empty for non-tool messages / malformed content.
 */
function toolResultIds(message: SessionMessage): string[] {
  if (message.role !== "tool") return [];
  const { content } = message;
  if (!Array.isArray(content)) return [];
  const ids: string[] = [];
  for (const part of content) {
    if (part.type === "tool-result") ids.push(part.toolCallId);
  }
  return ids;
}

/**
 * Ids of the contiguous run of `tool`-role messages immediately after
 * `messages[assistantIndex]` whose tool results answer `callIds`. The scan
 * stops at the first message that is not a `tool` role or does not answer
 * any of `callIds` (defensive — in valid AI SDK data the answering results
 * are the immediate followers of their calls).
 */
function answeringToolMessageIds(
  messages: readonly SessionMessage[],
  assistantIndex: number,
  callIds: readonly string[],
): string[] {
  if (callIds.length === 0) return [];
  const wanted = new Set(callIds);
  const ids: string[] = [];
  for (let i = assistantIndex + 1; i < messages.length; i++) {
    const msg = messages[i];
    if (msg === undefined || msg.role !== "tool") break;
    const answers = toolResultIds(msg).some((id) => wanted.has(id));
    if (!answers) break;
    ids.push(msg.id);
  }
  return ids;
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Returns the message ids to delete for a user-initiated single-message
 * delete, or `null` if the target is not found. Pair-aware:
 *
 * - `user` message → `[target]`
 * - `assistant` message → `[target, …ids of immediately-following tool
 *   messages whose tool results answer the target's toolCallIds]`
 * - `tool` message → `[parent assistant message (backward scan for the
 *   assistant message containing this toolCallId), …ALL tool messages
 *   answering that parent's toolCallIds]`
 *
 * Ids are returned in thread order. Deleting an orphan tool message (no
 * parent assistant found — malformed data) degrades to `[target]`.
 */
export function expandDeleteIds(
  messages: SessionMessage[],
  messageId: string,
): string[] | null {
  const targetIndex = messages.findIndex((m) => m.id === messageId);
  if (targetIndex === -1) return null;
  const target = messages[targetIndex];
  if (!target) return null; // unreachable given findIndex — narrows the type

  if (target.role === "assistant") {
    return [
      target.id,
      ...answeringToolMessageIds(messages, targetIndex, assistantToolCallIds(target)),
    ];
  }

  if (target.role === "tool") {
    // Backward scan for the nearest preceding assistant message containing
    // one of the target's tool-result ids (its parent call).
    const resultIds = new Set(toolResultIds(target));
    let parentIndex = -1;
    for (let i = targetIndex - 1; i >= 0; i--) {
      const candidate = messages[i];
      if (!candidate || candidate.role !== "assistant") continue;
      if (assistantToolCallIds(candidate).some((id) => resultIds.has(id))) {
        parentIndex = i;
        break;
      }
    }
    // Orphan (no parent call anywhere) — defensive: delete just the target.
    if (parentIndex === -1) return [target.id];
    const parent = messages[parentIndex];
    if (!parent) return [target.id]; // unreachable — narrows the type
    return [
      parent.id,
      ...answeringToolMessageIds(messages, parentIndex, assistantToolCallIds(parent)),
    ];
  }

  // `user` (and defensively `system`/future roles) — single target.
  return [target.id];
}

/**
 * Returns a NEW SessionMessage with its text content replaced by newText,
 * or null when the target cannot be edited. Never mutates the input.
 *
 * Targeting rules (binding, mirrors the render layer's derivation):
 * - role "user", partIndex null: string content → newText string; array
 *   content → [textPart(newText), ...nonTextParts] (composer shape; file
 *   parts — hydrated data URLs OR raw `attachment://` refs — pass through
 *   untouched and in order).
 * - role "assistant", partIndex null, string content → newText string.
 * - role "assistant", partIndex n (from block id `${msg.id}#text-${n}`,
 *   n = index within the content parts array): the part at n must be
 *   type "text" → its text replaced; all other parts (tool-call,
 *   reasoning, file, …) untouched. Non-text part at n → null.
 * - Anything else (partIndex non-null on string content or user role,
 *   other roles, missing part) → null.
 *
 * Works identically on the hydrated in-memory message and the RAW
 * persisted body JSON (file part data is opaque to this function).
 */
export function replaceMessageText(
  message: SessionMessage,
  partIndex: number | null,
  newText: string,
): SessionMessage | null {
  if (message.role === "user") {
    // A user message is edited as a whole — a partIndex has no meaning
    // (the composer shape has exactly one text part).
    if (partIndex !== null) return null;
    const { content } = message;
    if (typeof content === "string") {
      return { ...message, content: newText };
    }
    if (Array.isArray(content)) {
      // Composer shape: text first, then file parts. The edited text
      // becomes the single leading text part; every non-text part (file
      // attachments, whatever their data form) passes through in order.
      const nonTextParts = content.filter((part) => part.type !== "text");
      return {
        ...message,
        content: [{ type: "text", text: newText }, ...nonTextParts],
      };
    }
    return null;
  }

  if (message.role === "assistant") {
    const { content } = message;
    if (partIndex === null) {
      // String content edits as a whole; array content REQUIRES a part
      // index (which text block is being edited is ambiguous otherwise).
      if (typeof content === "string") {
        return { ...message, content: newText };
      }
      return null;
    }
    if (typeof content === "string" || !Array.isArray(content)) return null;
    const part = content[partIndex];
    if (!part || part.type !== "text") return null;
    const nextContent = [...content];
    nextContent[partIndex] = { type: "text", text: newText };
    return { ...message, content: nextContent };
  }

  // `tool` / `system` (and defensively future roles) — not editable.
  return null;
}
