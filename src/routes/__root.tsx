import { useEffect, useRef } from "react";
import {
  Outlet,
  createRootRoute,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";

import { TitleBar } from "@/components/title-bar";
import { KeepAliveProvider } from "@/components/keep-alive-outlet";
import { TabStateProvider } from "@/components/tab-state-provider";
import { Toaster } from "@/components/ui/sonner";
import { getAppSetting } from "@/api";
import { useSession } from "@/hooks";
import {
  applyColorTheme,
  applyTheme,
  watchSystemTheme,
  type ColorTheme,
  type ThemeMode,
} from "@/lib/theme";

function RootLayout() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Restore the last active Space tab on startup. The router boots at "/"
  // regardless of the persisted session, so without this the TitleBar shows
  // the active tab selected while the content area stays stuck on the
  // landing page (bug). Fires once per app session: a `didRestore` ref
  // guards against re-firing, and the `pathname === "/"` check ensures a
  // deep link (e.g. a refresh at `/space/…/world/…`) is never overridden.
  // Only navigates when there is actually a tab to restore; null active
  // (no open Spaces) correctly stays on the landing page.
  const sessionQ = useSession();
  const didRestore = useRef(false);
  useEffect(() => {
    if (didRestore.current) return;
    const activeId = sessionQ.data?.activeSpaceId ?? null;
    if (activeId != null && pathname === "/") {
      didRestore.current = true;
      navigate({ to: "/space/$spaceId", params: { spaceId: activeId } });
    }
  }, [sessionQ.data?.activeSpaceId, pathname, navigate]);

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

  // Tray re-lock (T27): when the window is hidden to the tray, the backend
  // (T15) locks every protected Space and emits `"spaces-locked"`. Invalidate
  // the session so `useSession()` refetches — locked Spaces then render the
  // in-page `SpacePasswordGate` overlay. `listen` resolves to an `unlisten`
  // fn; call it on cleanup so the subscription dies with the root.
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
          fn(); // already cleaned up — unlisten immediately
        } else {
          unlisten = fn;
        }
      })
      .catch(() => {
        // listen() rejected before resolving — subscription never
        // established, so there is nothing to tear down.
      });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [queryClient]);

  return (
    <KeepAliveProvider>
      <TabStateProvider>
        <div className="flex h-svh flex-col overflow-hidden bg-background text-foreground">
          <TitleBar />
          <div className="flex flex-1 overflow-hidden">
            <Outlet />
          </div>
          <Toaster />
        </div>
      </TabStateProvider>
    </KeepAliveProvider>
  );
}

export const rootRoute = createRootRoute({ component: RootLayout });
