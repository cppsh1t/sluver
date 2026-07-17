import { z } from "zod";

/**
 * 空间（Space）— 世界之上的隔离层。
 *
 * Space is the outer isolation tier above World. Each Space owns its own
 * World registry (`spaces/{spaceId}/space.db`) plus a directory of World
 * content databases. A Space may optionally be protected by an argon2id
 * password (auth gate, NOT encryption — see ADR-0008).
 *
 * `SpaceSummary` is the safe-to-send-to-frontend view: it never exposes
 * `password_hash`, only the boolean `hasPassword` flag.
 */

/** Branded ID for Space. Prevents passing a World/Session/... ID by mistake. */
export const spaceIdSchema = z.string().brand<"SpaceId">();
export type SpaceId = z.infer<typeof spaceIdSchema>;

/**
 * Safe view of a Space (no password hash). Mirrors the Rust `SpaceSummary`
 * struct — every field is `#[serde(rename_all = "camelCase")]` on the backend.
 */
export const spaceSummarySchema = z.object({
  id: spaceIdSchema,
  name: z.string(),
  /** Whether this Space is protected by a password. The hash itself never leaves the backend. */
  hasPassword: z.boolean(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type SpaceSummary = z.infer<typeof spaceSummarySchema>;

/** Payload for `create_space`. `password` is omitted (or `undefined`) for an unprotected Space. */
export const createSpaceInputSchema = z.object({
  name: z.string().min(1),
  password: z.string().optional(),
});

export type CreateSpaceInput = z.infer<typeof createSpaceInputSchema>;

/** Payload for `update_space`. Password changes go through `setSpacePassword`, not here. */
export const updateSpaceInputSchema = z.object({
  name: z.string().min(1).optional(),
});

export type UpdateSpaceInput = z.infer<typeof updateSpaceInputSchema>;

/**
 * Payload for `set_space_password`. Covers all three lifecycle operations:
 * - add:    `currentPassword = undefined`, `newPassword = <some>`  (no old password needed)
 * - change: `currentPassword = <old>`,     `newPassword = <some>`  (old password verified)
 * - remove: `currentPassword = <old>`,     `newPassword = undefined` (old password verified)
 */
export const setSpacePasswordInputSchema = z.object({
  currentPassword: z.string().optional(),
  newPassword: z.string().optional(),
});

export type SetSpacePasswordInput = z.infer<typeof setSpacePasswordInputSchema>;
