import { elementBaseSchema } from './element';
import { z } from 'zod';

/**
 * 物品（Item）— 世界中的道具、物件。
 *
 * Supplemental lore element. Edit form: 名称 + 内容描述 + 自由备注.
 */

export const itemIdSchema = z.string().brand<'ItemId'>();
export type ItemId = z.infer<typeof itemIdSchema>;

export const itemSchema = elementBaseSchema.extend({
  id: itemIdSchema,
});

export type Item = z.infer<typeof itemSchema>;

// ─── Item Summary ─────────────────────────────────────────────────────────

/**
 * Lightweight Item view — `id`, `name`, `tags` only.
 *
 * Returned by `list_item_summaries` and `search_items`. Call `get_item` for
 * description and notes.
 */
export const itemSummarySchema = z.object({
  id: itemIdSchema,
  name: z.string(),
  tags: z.array(z.string()),
});

export type ItemSummary = z.infer<typeof itemSummarySchema>;
