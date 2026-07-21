import { useEffect } from "react";
import { Outlet, createRootRoute } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { WindowTitleBar } from "@/components/window-title-bar";
import { Toaster } from "@/components/ui/sonner";
import { getAppSetting } from "@/api";
import {
  applyColorTheme,
  applyTheme,
  watchSystemTheme,
  type ColorTheme,
  type ThemeMode,
} from "@/lib/theme";

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
      .catch(() => apply());
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
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <WindowTitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
      <Toaster />
    </div>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
