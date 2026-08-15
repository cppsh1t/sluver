import type { AppSetting } from "@/types";

export type FontSetting = AppSetting["appearance"]["fontUi"];

/**
 * Sentinel value in `AppSetting.appearance.fontUi` / `fontArticle` meaning
 * "use the app default font" (Inter Variable). Any other value is a system
 * font family name as listed by the `list_system_fonts` command.
 */
export const DEFAULT_FONT = "default";

/** The app default stack — matches the `:root` fallback in index.css. */
const DEFAULT_STACK = "'Inter Variable', sans-serif";

/**
 * Build a CSS font-family stack from a persisted font setting.
 *
 * The sentinel maps to the app default; anything else is quoted and given a
 * generic `sans-serif` fallback (Windows font names routinely contain
 * spaces, so quoting is mandatory). Quotes AND backslashes are stripped from
 * the family name first so a mangled stored value can neither break out of
 * the CSS string nor escape the closing quote (CSS injection guard).
 */
export function fontStack(family: string): string {
  if (family === DEFAULT_FONT) return DEFAULT_STACK;
  const safe = family.replace(/["\\]/g, "").trim();
  if (!safe) return DEFAULT_STACK;
  return `"${safe}", sans-serif`;
}

/**
 * Apply the UI font to the document root by setting `--font-ui`. Everything
 * that uses `font-sans` (i.e. the whole app, plus headings via
 * `--font-heading: var(--font-sans)`) follows automatically.
 *
 * Call on app load (before first render) and whenever the user changes the
 * setting.
 */
export function applyUiFont(family: string): void {
  document.documentElement.style.setProperty("--font-ui", fontStack(family));
}

/**
 * Apply the article (prose) font to the document root by setting
 * `--font-article`. Only surfaces carrying the `font-article` utility
 * (scene writing textarea, chapter read-mode paragraphs) follow.
 */
export function applyArticleFont(family: string): void {
  document.documentElement.style.setProperty(
    "--font-article",
    fontStack(family),
  );
}
