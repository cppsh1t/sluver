import { z } from "zod";

/**
 * Conversation / Message — persisted AI chat transcripts.
 *
 * A Conversation is scoped to a Space + World and carries the agent config
 * name used plus a discriminator (`meta`) telling whether it is anchored to
 * the whole world or a single chapter. Each Conversation owns a list of
 * Messages, where `body` is the full ModelMessage JSON (opaque at this
 * layer — the runtime/store layer owns the narrowing).
 */

/** Branded ID for Conversation. Prevents passing a World/Novel/... ID by mistake. */
export const conversationIdSchema = z.string().brand<"ConversationId">();
export type ConversationId = z.infer<typeof conversationIdSchema>;

/** Where a Conversation is anchored: the whole world or a single chapter. */
export const conversationMetaSchema = z.union([
  z.object({ kind: z.literal("world") }),
  z.object({ kind: z.literal("chapter"), chapterId: z.string() }),
]);
export type ConversationMeta = z.infer<typeof conversationMetaSchema>;

export const conversationSchema = z.object({
  id: conversationIdSchema,
  agentConfigName: z.string(),
  title: z.string().nullable(),
  meta: conversationMetaSchema,
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type Conversation = z.infer<typeof conversationSchema>;

/**
 * A single persisted message.
 *
 * `body` is the full ModelMessage JSON — opaque at this layer; the
 * runtime/store layer owns the narrowing. Typed as `z.unknown()` to
 * avoid a layering dependency on the AI lib here.
 *
 * `usageInputTokens` / `usageOutputTokens` carry the per-turn token usage
 * (ADR-0030). Both are `number | null | undefined`:
 * - `undefined` — the field was not present in the payload (the row never
 *   carried usage — non-assistant rows, non-last assistant rows, or rows
 *   written by an older client before ADR-0030). Distinguishing `undefined`
 *   from `null` here lets callers omit the field entirely on writes where
 *   it does not apply.
 * - `null` — the provider reported no value for that half ("unknown").
 * - `number` (incl. `0`) — a real reported value.
 *
 * Per ADR-0030 §2, only ONE row per turn (the last `role === "assistant"`)
 * ever carries usage; the rest have it absent/`null`.
 */
export const messageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  body: z.unknown(),
  createdAt: z.iso.datetime(),
  usageInputTokens: z.number().int().nullable().optional(),
  usageOutputTokens: z.number().int().nullable().optional(),
});

export type Message = z.infer<typeof messageSchema>;
