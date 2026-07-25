import { useEffect } from "react";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { WindowTitleBar } from "@/components/window-title-bar";
import { ErrorBoundary } from "@/components/error-boundary";
import { Toaster } from "@/components/ui/sonner";
import { getAppSetting } from "@/api";
import { logger, type LogLevel, setLevel } from "@/lib/logger";
import {
  applyColorTheme,
  applyTheme,
  watchSystemTheme,
  type ColorTheme,
  type ThemeMode,
} from "@/lib/theme";

/**
 * Map a persisted verbosity tier to the frontend logger threshold.
 *
 * Inlined here (and in `settings-dialog.tsx`) rather than living in
 * `src/lib/logger/level.ts` because `level.ts` must not import from
 * `@/api/diagnostics` — that would create a cycle (the logger bridge is
 * imported transitively by the API layer). The mapping is a pure 3-arm
 * switch, so duplicating it at the two call sites is cheaper than a new
 * indirection module.
 *
 * Defensive `default` branch: `VerbosityTier` is a string read from SQLite,
 * so a hand-edited or migrated-from-old-name row could carry an unrecognized
 * value. Returning `"info"` (the documented production default) instead of
 * `undefined` keeps the logger functional and surfaces the bad value via
 * the `unknown_tier` marker so it shows up in diagnostics.
 */
function verbosityToLogLevel(tier: string): LogLevel {
  switch (tier) {
    case "standard":
      return "info";
    case "verbose":
      return "debug";
    case "very_verbose":
      return "trace";
    default:
      logger.warn("verbosity_tier.unknown", { tier });
      return "info";
  }
}

function RootLayout() {
  const queryClient = useQueryClient();

  // Load persisted appearance on boot and follow OS changes while on "system".
  useEffect(() => {
    let mode: ThemeMode = "system";
    let colorTheme: ColorTheme = "neutral";
    const apply = () => {
      applyTheme(mode);
      applyColorTheme(colorTheme);
    };
    getAppSetting()
      .then((c) => {
        mode = c.appearance.theme;
        colorTheme = c.appearance.colorTheme;
        apply();
      })
      .catch((e) => {
        // Persisted settings unreadable — fall back to defaults so the
        // UI still gets a deterministic theme applied.
        logger.warn("root.theme_apply.failed", { error: String(e) });
        apply();
      });
    return watchSystemTheme(() => applyTheme(mode));
  }, []);

  // Tray re-lock (T27): when the launcher window is hidden to tray, the
  // backend locks every protected Space and emits `"spaces-locked"`. Each
  // Space window receives this (Tauri events broadcast to all windows) and
  // invalidates its session cache so the in-page `SpacePasswordGate`
  // overlay appears. `listen` resolves to an `unlisten` fn; call it on
  // cleanup so the subscription dies with the root.
  //
  // Race guard: `listen()` returns a Promise. If the effect's cleanup runs
  // before that Promise resolves, `unlisten` is still `undefined` and the
  // subscription would leak permanently. We track a `cancelled` flag so a
  // late-resolving subscription is torn down immediately.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen("spaces-locked", () => {
      queryClient.invalidateQueries({ queryKey: ["session"] });
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((e) => {
        // CRITICAL: the spaces-locked subscription drives the ADR-0008
        // hide-to-tray re-lock flow. If this listener never attaches,
        // hidden Space windows silently stop re-locking — log at error
        // so the failure is visible in diagnostics.
        logger.error("root.spaces_locked_listen.failed", {
          error: String(e),
        });
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  // Cross-window log-threshold sync (ADR-0014). When the user changes the
  // verbosity tier in one window's Settings dialog, the Rust side reloads
  // the EnvFilter and emits `log-level-changed` to every window. Each
  // window mirrors the change into its own frontend logger threshold so
  // drop decisions stay consistent across windows without a re-fetch.
  //
  // Payload shape mirrors the Rust `LogLevelChangedPayload` struct
  // (`{ level, filter }`, camelCase via serde) — NOT a bare tier string.
  // Typing it as `VerbosityTier` would silently make `event.payload` an
  // object at runtime and break the switch in `verbosityToLogLevel`.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listen<{ level: string; filter: string }>("log-level-changed", (event) => {
      setLevel(verbosityToLogLevel(event.payload.level));
    })
      .then((fn) => {
        if (cancelled) {
          fn();
        } else {
          unlisten = fn;
        }
      })
      .catch((e) => {
        logger.error("root.log_level_listen.failed", {
          error: String(e),
        });
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <WindowTitleBar />
      <div className="flex flex-1 overflow-hidden">
        {/* ErrorBoundary catches render-time crashes anywhere in the route
            tree so the user never sees a white screen. Inside providers
            (i18n / theme / toaster are all set up above by the time this
            renders) but outside the page content. */}
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </div>
      <Toaster />
    </div>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
