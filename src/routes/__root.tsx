import { useEffect } from "react";
import { Outlet, createRootRoute } from "@tanstack/react-router";

import { TitleBar } from "@/components/title-bar";
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

  return (
    <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
      <TitleBar />
      <div className="flex flex-1 overflow-hidden">
        <Outlet />
      </div>
      <Toaster />
    </div>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
