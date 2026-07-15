import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import resourcesToBackend from "i18next-resources-to-backend";

/**
 * Supported UI locales. The folder name under `./locales/` matches the
 * canonical form here — anything else is normalized via `resolveLocale`.
 */
export const SUPPORTED_LOCALES = ["zh-CN", "en"] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Used when no preference is expressed and OS detection fails. */
export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Loaded when a key is missing for the active locale. */
export const FALLBACK_LOCALE: SupportedLocale = "en";

/**
 * Special sentinel stored in `AppConfig.locale` to indicate "follow the
 * OS locale" rather than a fixed language. Resolved at bootstrap via
 * `@tauri-apps/plugin-os`.
 */
export const AUTO_LOCALE = "auto";

export const NAMESPACES = ["common", "world", "worldbook", "settings", "errors", "character", "event"] as const;
export type Namespace = (typeof NAMESPACES)[number];

export const DEFAULT_NAMESPACE = "common" satisfies Namespace;

/**
 * Normalize an arbitrary locale tag (BCP-47 from the OS, saved user
 * preference, or `AUTO_LOCALE`) into one of {@link SUPPORTED_LOCALES}.
 *
 * Anything unrecognized falls back to {@link DEFAULT_LOCALE}. The mapping
 * is intentionally coarse: `zh-Hans-CN`, `zh-TW`, `zh` all collapse to
 * `zh-CN` because we only ship one Chinese translation.
 */
export function resolveLocale(raw: string | null | undefined): SupportedLocale {
  if (!raw) return DEFAULT_LOCALE;
  const lower = raw.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en";
  return DEFAULT_LOCALE;
}

i18n
  .use(
    resourcesToBackend((lng: string, ns: string) => {
      // Vite statically analyzes this template literal and pre-builds chunks
      // for every matching JSON file. We collapse any `zh-*` to the `zh-CN`
      // folder so we don't have to ship per-region translations.
      const folder = lng.toLowerCase().startsWith("zh") ? "zh-CN" : "en";
      return import(`./locales/${folder}/${ns}.json`);
    }),
  )
  .use(initReactI18next)
  .init({
    fallbackLng: FALLBACK_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...NAMESPACES],
    defaultNS: DEFAULT_NAMESPACE,
    interpolation: {
      // React already escapes interpolated values.
      escapeValue: false,
    },
    // No initial language — bootstrap calls `changeLanguage` explicitly
    // before React renders, so we never flash the fallback.
    lng: undefined,
    // React Suspense handles loading states; let i18next emit promises.
    react: {
      useSuspense: true,
    },
  });

export default i18n;
