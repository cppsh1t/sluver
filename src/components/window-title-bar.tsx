/**
 * Minimal frameless title bar — drag region + caption button host.
 *
 * `data-tauri-decorum-tb` is the escape hatch (decorum docs Pattern 2 / Issue
 * #41): when decorum's `titlebar.js` finds an existing element with this
 * attribute, it skips creating its own z-index:100 overlay and instead mounts
 * the caption buttons (minimize/maximize/close) INSIDE our element via
 * `controls.js`. This avoids the two-overlay conflict (Issue #32) where our
 * opaque drag region swallowed clicks meant for decorum's buttons.
 *
 * `data-tauri-drag-region` stays on the outer div — since decorum no longer
 * creates its own drag div, we must provide drag ourselves. Tauri v2's drag
 * region does NOT intercept clicks on interactive descendants (`<button>`),
 * so caption buttons work correctly inside this container.
 *
 * Each Space opens in its own OS window (ADR-0009, superseded the browser-style
 * tab bar); this title bar replaces that. macOS traffic lights are positioned
 * separately via `set_traffic_lights_inset` in Rust — no frontend change needed.
 *
 * Linux renders its OWN caption buttons here (ADR-0054): the Rust side skips
 * `create_overlay_titlebar()` on Linux because decorum 1.1.1's injected
 * controls are broken there — a dead empty button (KDE writes an `icon:`
 * button-layout prefix that decorum's `appmenu:`-only parsing turns into a
 * no-case control id) and duplicated button sets (the Linux script lacks the
 * Windows version's idempotency guard, so every page-load broadcast that
 * lands during document load appends another set). Windows keeps decorum for
 * the Win11 Snap Layout hover; macOS keeps native traffic lights.
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, Copy01Icon, MinusSignIcon, SquareIcon } from "@hugeicons/core-free-icons";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { platform } from "@tauri-apps/plugin-os";

import { logger } from "@/lib/logger";
import { cn } from "@/lib/utils";

type WindowAction = "minimize" | "toggle_maximize" | "close";

function invokeWindowControl(action: WindowAction, op: Promise<void>) {
  op.catch((e) => {
    logger.warn("titlebar.window_control.failed", { action, error: String(e) });
  });
}

// plugin-os injects `__TAURI_OS_PLUGIN_INTERNALS__` before app code runs, so
// platform() is synchronous — resolved once per window document, no flash.
const IS_LINUX = platform() === "linux";

/** Track maximize state so the middle button swaps maximize/restore icons. */
function useIsMaximized(enabled: boolean) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const win = getCurrentWindow();
    let cancelled = false;

    const sync = () => {
      win
        .isMaximized()
        .then((m) => {
          if (!cancelled) setMaximized(m);
        })
        .catch((e) => {
          logger.warn("titlebar.maximize_state.failed", { error: String(e) });
        });
    };

    sync();
    const unlistenP = win.onResized(sync);

    return () => {
      cancelled = true;
      unlistenPromiseCleanup(unlistenP);
    };
  }, [enabled]);

  return maximized;
}

function unlistenPromiseCleanup(unlistenP: Promise<() => void>) {
  unlistenP.then(
    (unlisten) => unlisten(),
    (e) => {
      logger.warn("titlebar.resize_listen.cleanup_failed", { error: String(e) });
    },
  );
}

function CaptionButton({
  label,
  danger = false,
  onClick,
  children,
}: {
  readonly label: string;
  readonly danger?: boolean;
  readonly onClick: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className={cn(
        "flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors",
        "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
        danger && "hover:bg-destructive hover:text-white",
      )}
    >
      {children}
    </button>
  );
}

/** Linux-only caption button group (ADR-0054). */
function LinuxCaptionButtons() {
  const { t } = useTranslation("common");
  const maximized = useIsMaximized(true);

  return (
    <div className="relative z-10 mr-1 flex items-center gap-0.5">
      <CaptionButton
        label={t("common:window.minimize")}
        onClick={() => invokeWindowControl("minimize", getCurrentWindow().minimize())}
      >
        <HugeiconsIcon icon={MinusSignIcon} strokeWidth={2} className="size-3.5" />
      </CaptionButton>
      <CaptionButton
        label={maximized ? t("common:window.restore") : t("common:window.maximize")}
        onClick={() => invokeWindowControl("toggle_maximize", getCurrentWindow().toggleMaximize())}
      >
        <HugeiconsIcon
          icon={maximized ? Copy01Icon : SquareIcon}
          strokeWidth={2}
          className="size-3"
        />
      </CaptionButton>
      <CaptionButton
        label={t("common:window.close")}
        danger
        onClick={() => invokeWindowControl("close", getCurrentWindow().close())}
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3.5" />
      </CaptionButton>
    </div>
  );
}

export function WindowTitleBar() {
  return (
    <div
      data-tauri-decorum-tb
      data-tauri-drag-region
      className="relative flex h-9 shrink-0 items-center justify-end bg-background"
    >
      <span className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 select-none text-xs font-medium tracking-wide text-muted-foreground/50">
        Sluver
      </span>
      {IS_LINUX && <LinuxCaptionButtons />}
      {/* On Windows, decorum's controls.js appends caption <button> elements
          here on DOMContentLoaded (Linux renders its own above — ADR-0054). */}
    </div>
  );
}

