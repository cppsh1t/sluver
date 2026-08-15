import { z } from 'zod';

import { AUTO_LOCALE, SUPPORTED_LOCALES } from '@/i18n';

/**
 * 设置（Setting）— 应用级外观与语言设置。
 *
 * v0.1.0 原型阶段：模型配置（provider / modelName / apiKey / baseUrl）
 * 写死在 `.env` 中，不存入 Setting。后期支持自定义 provider 时再迁入。
 */
export const appSettingSchema = z.object({
  /** UI appearance settings. */
  appearance: z.object({
    /** Controls the `.dark` class on the root element. */
    theme: z.enum(['light', 'dark', 'system']),
    /** Controls the `data-color-theme` attribute: the active color palette. */
    colorTheme: z.enum(['neutral', 'parchment']),
    /**
     * Font family for app chrome (everything `font-sans` touches). The
     * sentinel {@link DEFAULT_FONT} ("default") means the app default
     * (Inter Variable); any other value is a system font family name.
     */
    fontUi: z.string(),
    /**
     * Font family for prose surfaces (scene writing textarea, chapter
     * read-mode paragraphs). Same sentinel semantics as {@link fontUi}.
     */
    fontArticle: z.string(),
  }),
  /**
   * Active UI locale. Either {@link AUTO_LOCALE} (follow OS) or one of
   * {@link SUPPORTED_LOCALES}. The backend tolerates arbitrary strings
   * (it just stores the value), but the Zod schema is strict so typos
   * surface as a parse error rather than a silent fallback at runtime.
   */
  locale: z.enum([AUTO_LOCALE, ...SUPPORTED_LOCALES]),
});

export type AppSetting = z.infer<typeof appSettingSchema>;
