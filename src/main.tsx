import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "@tanstack/react-router";
import { locale as detectOsLocale } from "@tauri-apps/plugin-os";

import { router } from "./router";
import { getAppConfig } from "@/api";
import {
  AUTO_LOCALE,
  DEFAULT_LOCALE,
  resolveLocale,
} from "@/i18n";
import i18n from "@/i18n";
import { setDayjsLocale } from "@/lib/format";

import "./index.css";

/**
 * Resolve the active UI locale at startup.
 *
 * Priority chain (first wins):
 *   1. User's saved preference in `AppConfig.locale`
 *        - `"auto"` → defer to OS locale (step 2)
 *        - any BCP-47 tag → use as-is (normalized by `resolveLocale`)
 *   2. OS locale via `@tauri-apps/plugin-os`
 *   3. {@link DEFAULT_LOCALE} ("en")
 *
 * Each external call is independently guarded so that a failure at any
 * step (DB locked, plugin permission missing, OS API unavailable) falls
 * through to the next source instead of blocking app startup.
 */
async function resolveInitialLocale(): Promise<string> {
  // 1. Saved preference
  let saved: string | undefined;
  try {
    saved = (await getAppConfig()).locale;
  } catch {
    // AppConfig unreachable (e.g. migration issue) — fall through.
  }

  if (saved && saved !== AUTO_LOCALE) {
    return resolveLocale(saved);
  }

  // 2. OS locale (only relevant when saved is "auto" or missing)
  try {
    const os = await detectOsLocale();
    if (os) return resolveLocale(os);
  } catch {
    // Plugin not permitted or unavailable — fall through.
  }

  // 3. Default
  return DEFAULT_LOCALE;
}

/**
 * Initialize i18n + dayjs locale, then mount React.
 *
 * `i18n.changeLanguage` triggers the lazy namespace loaders in
 * `src/i18n/index.ts` (dynamic `import()` per namespace). We await it
 * before rendering so the initial paint already has translations — no
 * flash of fallback language. `setDayjsLocale` is called right after so
 * relative timestamps (e.g. "3 days ago") match the active language.
 *
 * Bootstrap failures (e.g. every namespace JSON missing) are swallowed
 * here: i18next falls back to `FALLBACK_LOCALE` internally and React
 * still mounts, so the user is never stuck on a blank window.
 */
resolveInitialLocale()
  .then(async (lng) => {
    await i18n.changeLanguage(lng);
    setDayjsLocale(lng);
  })
  .catch(() => {
    // Swallow — render anyway with whatever i18next managed to load.
  })
  .finally(() => {
    createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {/* Suspense catches the (rare) case where a lazy namespace chunk
            is still loading after bootstrap, e.g. user switched language
            post-mount and triggered a re-fetch. */}
        <Suspense fallback={null}>
          <RouterProvider router={router} />
        </Suspense>
      </React.StrictMode>,
    );
  });
