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
