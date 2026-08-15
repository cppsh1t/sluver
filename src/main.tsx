import React, { Suspense } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactQueryDevtools } from "@tanstack/react-query-devtools";
import { RouterProvider } from "@tanstack/react-router";
import { locale as detectOsLocale } from "@tauri-apps/plugin-os";

import { router } from "./router";
import { getAppSetting, getModelsDevCatalog, setTrayLocale } from "@/api";
import {
  AUTO_LOCALE,
  DEFAULT_LOCALE,
  resolveLocale,
} from "@/i18n";
import i18n from "@/i18n";
import { setDayjsLocale } from "@/lib/format";
import {
  applyArticleFont,
  applyUiFont,
  DEFAULT_FONT,
} from "@/lib/font";
import { logger } from "@/lib/logger";
import { flush as flushLogBuffer } from "@/lib/logger/buffer";
import type { AppSetting } from "@/types";

import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

/**
 * Bootstrap appearance settings and resolve the active UI locale at startup.
 *
 * The persisted {@link AppSetting} is fetched ONCE and shared: font prefs
 * (appearance.fontUi / fontArticle) are applied to the document root BEFORE
 * the first React render so the initial paint already has the user's fonts —
 * no flash of the default — and `locale` feeds the resolution chain below.
 *
 * Locale priority chain (first wins):
 *   1. User's saved preference in `AppSetting.locale`
 *        - `"auto"` → defer to OS locale (step 2)
 *        - any BCP-47 tag → use as-is (normalized by `resolveLocale`)
 *   2. OS locale via `@tauri-apps/plugin-os`
 *   3. {@link DEFAULT_LOCALE} ("en")
 *
 * Each external call is independently guarded so that a failure at any
 * step (DB locked, plugin permission missing, OS API unavailable, malformed
 * font value) falls through to the next source instead of blocking app
 * startup.
 */
async function bootstrapSettings(): Promise<string> {
  // 1. Saved preference (single fetch — shared by fonts + locale)
  let setting: AppSetting | undefined;
  try {
    setting = await getAppSetting();
  } catch {
    // AppSetting unreachable (e.g. migration issue) — fall through.
  }

  // Apply fonts before the first render. `?? DEFAULT_FONT` covers a payload
  // from an older backend that predates the font fields; each application
  // is guarded so one bad value never blocks the other or the locale chain.
  try {
    applyUiFont(setting?.appearance.fontUi ?? DEFAULT_FONT);
  } catch {
    // Stylesheet default (Inter Variable) stays in effect.
  }
  try {
    applyArticleFont(setting?.appearance.fontArticle ?? DEFAULT_FONT);
  } catch {
    // Stylesheet default (Inter Variable) stays in effect.
  }

  const saved = setting?.locale;
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
 * Global error listeners — installed synchronously at module load (BEFORE
 * the bootstrap chain and the first React render) so they capture uncaught
 * errors and unhandled promise rejections from the entire app lifecycle,
 * including the bootstrap phase itself.
 *
 * Entries emitted before the Tauri IPC bridge is ready are buffered and
 * flushed later by `flushLogBuffer()` once bootstrap succeeds.
 *
 * We deliberately do NOT call `event.preventDefault()`: we want BOTH the
 * structured log entry AND the browser's default devtools warning, since
 * the devtools trace is richer than anything we can reconstruct.
 */
window.addEventListener("unhandledrejection", (event) => {
  logger.error("window.unhandledrejection", {
    reason: String(event.reason),
  });
});
window.addEventListener("error", (event) => {
  logger.error("window.error", {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    col: event.colno,
  });
});

/**
 * Initialize i18n + dayjs locale, then mount React.
 *
 * `i18n.changeLanguage` triggers the lazy namespace loaders in
 * `src/i18n/index.ts` (dynamic `import()` per namespace). We await it
 * before rendering so the initial paint already has translations — no
 * flash of fallback language. `setDayjsLocale` is called right after so
 * relative timestamps (e.g. "3 days ago") match the active language.
 *
 * Bootstrap failures (e.g. every namespace JSON missing) are logged but
 * not surfaced: i18next falls back to `FALLBACK_LOCALE` internally and
 * React still mounts, so the user is never stuck on a blank window.
 */
bootstrapSettings()
  .then(async (lng) => {
    await i18n.changeLanguage(lng);
    setDayjsLocale(lng);
    // Sync the tray menu labels to the resolved locale. Best-effort: a
    // failure leaves the tray on its English startup default, which is
    // preferable to blocking the render pipeline.
    setTrayLocale(lng).catch((e) =>
      logger.warn("bootstrap.set_tray_locale.failed", {
        locale: lng,
        error: String(e),
      }),
    );
    // Warm the models.dev catalog cache (ADR-0012). Fire-and-forget: the
    // Space config page re-fetches via React Query if this hasn't landed
    // by the time the user navigates there, so a failure here is silent.
    getModelsDevCatalog().catch((e) =>
      logger.warn("bootstrap.catalog_warm.failed", { error: String(e) }),
    );
    // Locale/theme setup succeeded and at least one Tauri IPC round-trip
    // (getAppSetting in bootstrapSettings) has completed — the bridge
    // is alive. Drain any log entries that arrived before it came up.
    void flushLogBuffer();
  })
  .catch((e) => {
    // Render still proceeds via .finally() with whatever i18next managed
    // to load; the error is logged for diagnostics but not surfaced.
    logger.error("bootstrap.failed", { error: String(e) });
  })
  .finally(() => {
    createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        <QueryClientProvider client={queryClient}>
          {/* Suspense catches the (rare) case where a lazy namespace chunk
              is still loading after bootstrap, e.g. user switched language
              post-mount and triggered a re-fetch. */}
          <Suspense fallback={null}>
            <RouterProvider router={router} />
          </Suspense>
          {import.meta.env.DEV && <ReactQueryDevtools />}
        </QueryClientProvider>
      </React.StrictMode>,
    );
  });
