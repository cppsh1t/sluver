import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import "dayjs/locale/zh-cn";
import "dayjs/locale/en";

dayjs.extend(relativeTime);

/**
 * Currently active dayjs locale, tracked so we only call `dayjs.locale()`
 * when the value actually changes (avoiding needless global mutations).
 */
let currentDayjsLocale: string | null = null;

/**
 * Synchronize the global dayjs locale with the active i18n language.
 *
 * Called at bootstrap (after `i18n.changeLanguage`) and again whenever the
 * user manually switches language in settings. dayjs only ships with `en`
 * by default; both `zh-cn` and `en` are imported above so Vite bundles
 * them and this function is synchronous.
 */
export function setDayjsLocale(lng: string): void {
  const next = lng.toLowerCase().startsWith("zh") ? "zh-cn" : "en";
  if (currentDayjsLocale !== next) {
    dayjs.locale(next);
    currentDayjsLocale = next;
  }
}

/**
 * Format an ISO timestamp as a locale-aware relative time string
 * (e.g. `"3 天前"` under `zh-cn`, `"3 days ago"` under `en`).
 *
 * The output language follows whatever was last passed to
 * {@link setDayjsLocale}; call that at bootstrap and on language change.
 */
export function formatRelativeTime(iso: string): string {
  return dayjs(iso).fromNow();
}

/**
 * Compact token-count formatter for the AI-chat usage surfaces (ADR-0030).
 *
 * Abbreviates large counts with a `k` / `M` suffix (locale-agnostic — both
 * zh-CN and en use the same SI-style suffix) so a 200k context window reads
 * `200k`, not `200000`. Values under 1000 render as-is. Always renders
 * integers without a thousands separator (token counts are technical readouts,
 * not financial figures — a `47.2k` reads faster than `47,200`).
 *
 * - `0` → `"0"` (a real zero, distinct from unknown — ADR-0030 §4)
 * - `< 1000` → the bare number
 * - `< 1_000_000` → one decimal of `k` (`47200` → `"47.2k"`, dropping a
 *   trailing `.0` so `50000` → `"50k"` not `"50.0k"`)
 * - otherwise → one decimal of `M`
 */
export function formatTokenCount(tokens: number): string {
  if (tokens < 1000) return String(tokens);
  if (tokens < 1_000_000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  const m = tokens / 1_000_000;
  return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
}
