import { z } from 'zod';

import { AUTO_LOCALE, SUPPORTED_LOCALES } from '@/i18n';

/**
 * 配置（Config）— 应用级外观与语言配置。
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
  /**
   * Active UI locale. Either {@link AUTO_LOCALE} (follow OS) or one of
   * {@link SUPPORTED_LOCALES}. The backend tolerates arbitrary strings
   * (it just stores the value), but the Zod schema is strict so typos
   * surface as a parse error rather than a silent fallback at runtime.
   */
  locale: z.enum([AUTO_LOCALE, ...SUPPORTED_LOCALES]),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
