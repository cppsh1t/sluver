import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { downloadDir, join } from "@tauri-apps/api/path";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";

import { Button } from "@/components/ui/button";
import { logger } from "@/lib/logger";
import { dateRange, exportLogs } from "@/api/diagnostics";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
  /** 8-char deterministic hash of `error.message + error.stack` — gives users
   *  a short token to quote in support threads; we can grep the unified log
   *  file (ADR-0015) for the matching `error_id` field to find the full trace. */
  errorId: string;
}

// ─── Hash ────────────────────────────────────────────────────────────────────

/**
 * djb2 (Bernstein) — a small, dependency-free string hash. We need
 * deterministic IDs (same crash → same id, so deduping / correlating reports
 * is possible) but NOT cryptographic strength; djb2's collision rate is
 * fine for an 8-hex-char user-facing token.
 *
 * `>>> 0` coerces to uint32 so `toString(16)` never produces a leading `-`.
 * `padStart(8, "0").slice(0, 8)` keeps the token a fixed width regardless of
 * the input length.
 *
 * Adapted from the canonical djb2 implementation published by Daniel J.
 * Bernstein (no explicit license; the algorithm is public domain by long
 * standing convention and is widely reimplemented).
 */
function hashError(message: string, stack: string | undefined): string {
  const input = `${message}\n${stack ?? ""}`;
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    // hash * 33 + charCode  (equivalent to (hash << 5) + hash)
    hash = (hash * 33 + input.charCodeAt(i)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").slice(0, 8);
}

// ─── Class boundary ──────────────────────────────────────────────────────────

/**
 * Top-level React error boundary (ADR-implicit: render-time crashes must not
 * leave a white screen).
 *
 * Functional components CANNOT be error boundaries — `getDerivedStateFromError`
 * + `componentDidCatch` are class-only lifecycle methods — so this is one of
 * the few class components in the codebase. The fallback UI is delegated to a
 * functional child ({@link ErrorFallback}) so it can use `useTranslation` /
 * `useState` normally (class components can't use hooks).
 *
 * Wire-up: wraps `<Outlet />` in `__root.tsx`, INSIDE the providers so the
 * fallback still has i18n / theme / toast available, OUTSIDE the page content
 * so a crash in any route is caught.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null, errorId: "" };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return {
      error,
      errorId: hashError(error.message, error.stack),
    };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // Forward to the unified log file (ADR-0014 / ADR-0015). Field names are
    // snake_case per ADR-0016 so they're greppable alongside Rust entries.
    // Do NOT rethrow — the whole point is to recover into the fallback UI.
    logger.error("react.render_crash", {
      error: String(error),
      component_stack: String(info.componentStack),
      error_id: this.state.errorId,
    });
  }

  override render(): ReactNode {
    const { error, errorId } = this.state;
    if (error === null) return this.props.children;
    return <ErrorFallback errorId={errorId} />;
  }
}

// ─── Fallback UI ─────────────────────────────────────────────────────────────

interface ErrorFallbackProps {
  errorId: string;
}

function ErrorFallback({ errorId }: ErrorFallbackProps) {
  const { t } = useTranslation("common");
  const [isExporting, setIsExporting] = useState(false);

  function handleReload(): void {
    window.location.reload();
  }

  async function handleExportLogs(): Promise<void> {
    if (isExporting) return;
    setIsExporting(true);
    try {
      // No Space filter from the crash UI — we don't know which Space the
      // user was in (the crash may have happened in the launcher), so send
      // the whole unified log file. ADR-0015 documents this trade-off.
      const dir = await downloadDir();
      // Local date so the filename matches the user's wall clock; UTC would
      // drift by a day for evening exporters west of GMT.
      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const fileName = `sluver-logs-${yyyy}-${mm}-${dd}.zip`;
      const outputPath = await join(dir, fileName);
      await exportLogs({ outputPath, dateRange: dateRange.all() });
      toast.success(t("exportSuccess", { path: outputPath }));
    } catch (e) {
      // The export pipeline can fail at several layers (path permission
      // denied, disk full, IPC torn down). Log the raw error for grep,
      // show the user a generic localized toast — the path is not in the
      // toast because we may never have resolved it.
      logger.error("error_boundary.export_logs.failed", {
        error: String(e),
      });
      toast.error(t("exportFailed"));
    } finally {
      setIsExporting(false);
    }
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex h-full w-full items-center justify-center p-6"
    >
      <div className="flex w-full max-w-md flex-col items-center gap-5 text-center">
        <HugeiconsIcon
          icon={Alert02Icon}
          strokeWidth={1.5}
          className="size-12 text-destructive"
        />
        <div className="flex flex-col gap-2">
          <h1 className="font-heading text-lg font-semibold text-foreground">
            {t("title")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("description")}
          </p>
        </div>
        <dl className="flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-1 text-xs text-muted-foreground">
          <dt>{t("errorIdLabel")}:</dt>
          <dd className="font-mono">{errorId}</dd>
        </dl>
        <div className="flex items-center gap-2">
          <Button type="button" onClick={handleReload}>
            {t("reload")}
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={handleExportLogs}
            disabled={isExporting}
          >
            {isExporting ? t("exporting") : t("exportLogs")}
          </Button>
        </div>
      </div>
    </div>
  );
}

export { ErrorBoundary };
