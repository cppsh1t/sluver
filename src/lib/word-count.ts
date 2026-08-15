/**
 * Shared word-count semantics for scene body text.
 *
 * Single source of truth so the per-scene count (SceneCard footer) and the
 * chapter-total count (chapter workspace header) always agree.
 *
 * CJK languages (zh/ja/ko) count non-whitespace characters; every other
 * language counts whitespace-separated words. Empty content counts as 0.
 */

/** True when the BCP-47 tag is a CJK language (zh, ja, ko — incl. regional variants). */
export function isCJKLanguage(language: string): boolean {
  return ["zh", "ja", "ko"].some((l) => language.startsWith(l));
}

/**
 * Count words in scene body content for the given i18n language tag
 * (e.g. `i18n.language`).
 */
export function countWords(content: string, language: string): number {
  if (isCJKLanguage(language)) {
    return content.replace(/\s/g, "").length;
  }
  return content.trim() ? content.trim().split(/\s+/).length : 0;
}
