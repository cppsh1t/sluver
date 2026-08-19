import { z } from "zod";

/**
 * Chat message attachments (ADR-0044) — the sidecar blob rows that ride
 * alongside user chat messages (`message_attachments` in world.db,
 * WORLD_MIGRATION_013).
 *
 * Attachment ids are client-minted UUID v4 (`crypto.randomUUID()` at
 * dehydrate time) and stored verbatim — the exact precedent of `messages.id`.
 * They NEVER cross into entity-id space (no World/Character/... confusion is
 * possible), so they are deliberately UNBRANDED plain strings.
 */

/** The DB CHECK constraint domain (WORLD_MIGRATION_013). */
export const attachmentKindSchema = z.enum(["image", "text"]);
export type AttachmentKind = z.infer<typeof attachmentKindSchema>;

/**
 * Input for one attachment, supplied inline on a {@link Message} for
 * `append_messages` and inserted in the same transaction (plan D2).
 *
 * `dataBase64` is the standard-alphabet base64 of the raw bytes; Rust
 * re-decodes, validates (mime allowlist + size + UTF-8 for text), and stores
 * the BLOB. `sizeBytes` is computed server-side from the decoded length —
 * it is NOT a client field.
 */
export const attachmentInputSchema = z.object({
  id: z.string(),
  /** 0-based order within the message, fixed at send time. */
  position: z.number().int().nonnegative(),
  kind: attachmentKindSchema,
  mime: z.string(),
  /** Original filename. User creative content — NEVER logged (ADR-0016). */
  filename: z.string(),
  dataBase64: z.string(),
});

export type AttachmentInput = z.infer<typeof attachmentInputSchema>;

/**
 * Metadata-only view of a stored attachment row — NO blob. Returned by
 * `list_message_attachments`; the bytes themselves flow only through
 * `get_message_attachment` as a binary IPC response.
 */
export const attachmentMetaSchema = z.object({
  id: z.string(),
  messageId: z.string(),
  position: z.number().int().nonnegative(),
  kind: attachmentKindSchema,
  mime: z.string(),
  filename: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});

export type AttachmentMeta = z.infer<typeof attachmentMetaSchema>;
