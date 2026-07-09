import { elementBaseSchema } from './element';
import { z } from 'zod';

/**
 * 地点（Location）— 世界中的场所。
 *
 * Supplemental lore element. Edit form: 名称 + 内容描述 + 自由备注.
 */

export const locationIdSchema = z.string().brand<'LocationId'>();
export type LocationId = z.infer<typeof locationIdSchema>;

export const locationSchema = elementBaseSchema.extend({
  id: locationIdSchema,
});

export type Location = z.infer<typeof locationSchema>;
