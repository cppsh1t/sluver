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
