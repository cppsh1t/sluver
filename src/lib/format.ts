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

/**
 * Compact locale-aware count formatter for card metadata (e.g. novel 字数).
 *
 * Exists because raw 7-digit totals are unreadable on cards — compact
 * notation abbreviates them via `Intl.NumberFormat` (`1230000` → `"123万"`
 * under zh locales, following the 万 convention, `"1.2M"` under en). `0`
 * renders as `"0"`. Unknown locale tags are passed through; `Intl` itself
 * falls back to a default locale.
 */
export function formatCompactCount(n: number, locale: string): string {
  return new Intl.NumberFormat(locale, { notation: "compact" }).format(n);
}

/**
 * Compact locale-agnostic duration formatter for tool-card readouts
 * (`230ms` / `1.4s` / `2m 3s`), mirroring the technical-readout convention
 * of {@link formatTokenCount} — units are SI-style and never localized.
 *
 * - `< 1000` → rounded whole `ms` (sub-100ms calls read `230ms`, not `0.2s`)
 * - `< 60_000` → seconds with one decimal, dropping a trailing `.0`
 *   (`1400` → `"1.4s"`, `5000` → `"5s"`)
 * - otherwise → `m` / `m s` with rounded leftover seconds (`123456` →
 *   `"2m 3s"`; exact minutes drop the seconds part, `60000` → `"1m"`)
 */
export function formatDurationMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const s = ms / 1000;
    return `${Number.isInteger(s) ? s : s.toFixed(1)}s`;
  }
  const m = Math.floor(ms / 60_000);
  const rem = Math.round((ms % 60_000) / 1000);
  return rem === 0 ? `${m}m` : `${m}m ${rem}s`;
}
