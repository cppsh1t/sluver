import { z } from 'zod';

/**
 * 配置（Config）— 应用级外观配置。
 *
 * v0.1.0 原型阶段：模型配置（provider / modelName / apiKey / baseUrl）
 * 写死在 `.env` 中，不存入 Config。后期支持自定义 provider 时再迁入。
 */
export const appConfigSchema = z.object({
  /** UI appearance settings. */
  appearance: z.object({
    /** Controls the `.dark` class on the root element. */
    theme: z.enum(['light', 'dark', 'system']),
    /** Controls the `data-color-theme` attribute: the active color palette. */
    colorTheme: z.enum(['neutral', 'parchment']),
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
