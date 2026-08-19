/**
 * Chat message attachment IPC API (ADR-0044).
 *
 * Attachments are WRITTEN exclusively through `append_messages` (inline
 * `AttachmentInput` rows inside its single transaction — see
 * `./conversation.ts`); there is deliberately no standalone add/delete
 * command. This module wraps the two READ paths:
 *
 * - `getMessageAttachment` — raw bytes as a binary IPC response
 *   (`tauri::ipc::Response`, same wire form as `getSceneImage`).
 * - `listMessageAttachments` — metadata-only rows (no blob).
 *
 * All arg keys are camelCase; `#[serde(rename_all = "camelCase")]` on the
 * Rust side auto-converts to the snake_case the commands receive.
 */

import { call, toErrorPayload } from "./client";
import type { AttachmentMeta, WorldId } from "@/types";

/**
 * Fetch one attachment's raw bytes.
 *
 * @returns `ArrayBuffer` when the attachment exists, `null` when the backend
 *          returns `NOT_FOUND` (row missing / conversation deleted). All
 *          other errors propagate.
 */
export async function getMessageAttachment(
  spaceId: string,
  worldId: WorldId,
  attachmentId: string,
): Promise<ArrayBuffer | null> {
  try {
    return await call<ArrayBuffer>("get_message_attachment", {
      spaceId,
      worldId,
      id: attachmentId,
    });
  } catch (e) {
    if (toErrorPayload(e).code === "NOT_FOUND") return null;
    throw e;
  }
}

/**
 * List a message's attachment metadata in position order (no blobs).
 *
 * Returns an empty array for an unknown message id — never throws —
 * mirroring `load_messages` semantics. Use {@link getMessageAttachment} to
 * resolve each entry's bytes.
 */
export function listMessageAttachments(
  spaceId: string,
  worldId: WorldId,
  messageId: string,
): Promise<AttachmentMeta[]> {
  return call<AttachmentMeta[]>("list_message_attachments", {
    spaceId,
    worldId,
    messageId,
  });
}
