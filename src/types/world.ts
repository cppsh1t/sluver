import { z } from "zod";

/**
 * 世界（World）— 一个完整的设定宇宙，是创作的工作空间。
 *
 * World is the top-level container. All other elements (Novel, Character,
 * Location, Item, Lore, Event) are scoped to a World and reference it
 * via `worldId`.
 */

/** Branded ID for World. Prevents passing a Novel/Chapter/... ID by mistake. */
export const worldIdSchema = z.string().brand<"WorldId">();
export type WorldId = z.infer<typeof worldIdSchema>;

export const worldSchema = z.object({
  id: worldIdSchema,
  name: z.string(),
  /** High-level description / setting overview of this world. */
  description: z.string(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export type World = z.infer<typeof worldSchema>;
