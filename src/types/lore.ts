import { elementBaseSchema } from './element';
import { z } from 'zod';

/**
 * 设定（Lore）— 世界观补充说明（势力、魔法体系、历史背景等）。
 *
 * Supplemental lore element. Edit form: 名称 + 内容描述 + 自由备注.
 */

export const loreIdSchema = z.string().brand<'LoreId'>();
export type LoreId = z.infer<typeof loreIdSchema>;

export const loreSchema = elementBaseSchema.extend({
  id: loreIdSchema,
});

export type Lore = z.infer<typeof loreSchema>;
