import { z } from "zod";
import { worldIdSchema } from "./world";

/**
 * Shared base for supplemental world elements (Item / Location / Lore).
 *
 * These three entities are structurally identical at v0.1.0 — each is a
 * world-scoped named element with a description, free-form notes, and tags.
 * Centralizing the shared fields here keeps them in lockstep; per-domain
 * schemas extend this base and may diverge later.
 *
 * `id` is intentionally omitted — each domain owns its own branded id schema
 * (LocationId / ItemId / LoreId) to prevent cross-entity ID confusion.
 *
 * Internal: not re-exported from the barrel. Use `itemSchema` / `locationSchema`
 * / `loreSchema` from `@/types` instead.
 */
export const elementBaseSchema = z.object({
  worldId: worldIdSchema,
  name: z.string(),
  /** Detailed description of the element. */
  description: z.string(),
  /** Free-form notes (markdown). */
  notes: z.string(),
  /** User-defined tags for categorization / filtering. */
  tags: z.array(z.string()),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});
