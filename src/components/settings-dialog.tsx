import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { locale as detectOsLocale } from "@tauri-apps/plugin-os";
import { openPath } from "@tauri-apps/plugin-opener";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { downloadDir, join } from "@tauri-apps/api/path";
import dayjs from "dayjs";
import { HugeiconsIcon } from "@hugeicons/react";
import { ChevronDownIcon } from "@hugeicons/core-free-icons";

import { resolveLocale, AUTO_LOCALE } from "@/i18n";
import i18n from "@/i18n";
import {
  clearLogs,
  dateRange,
  exportLogs,
  getAppSetting,
  getLogLevel,
  getLogsDir,
  listSystemFonts,
  setLogLevel,
  setTrayLocale,
  updateAppSetting,
  type DateRange,
  type VerbosityTier,
} from "@/api";
import { toErrorPayload } from "@/api/client";
import { setDayjsLocale } from "@/lib/format";
import { logger, setLevel, type LogLevel } from "@/lib/logger";
import {
  applyArticleFont,
  applyUiFont,
  DEFAULT_FONT,
  fontStack,
} from "@/lib/font";
import {
  applyColorTheme,
  applyTheme,
  type ColorTheme,
  type ThemeMode,
} from "@/lib/theme";
import { cn } from "@/lib/utils";
import type { AppSetting } from "@/types";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectList,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Map a persisted verbosity tier to the frontend logger threshold.
 *
 * Duplicated from `src/routes/__root.tsx` — see the note there for why it
 * isn't shared: `src/lib/logger/level.ts` cannot import `VerbosityTier`
 * from `@/api/diagnostics` without creating a cycle, and a standalone
 * mapping module for a 3-arm switch is not worth the indirection.
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

/**
 * Derive the current Space id (if any) from the router location. Matches
 * the regex in `app-sidebar.tsx` but is intentionally broader: any
 * `/space/{id}/...` route counts as "inside a Space", including World
 * routes (`/space/{id}/world/...`). The export dialog uses this to default
 * the Space-scope filter to "current Space" when opened from within one.
 */
function useCurrentSpaceId(): string | null {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return useMemo(
    () => pathname.match(/^\/space\/([^/]+)/)?.[1] ?? null,
    [pathname],
  );
}

/**
 * Global application settings (CONTEXT.md `Setting`) as a modal.
 *
 * `Setting`s live ABOVE the Space layer — locale, theme, accent color — so
 * they are presented as a dialog opened from any window (launcher or Space)
 * rather than a route. Navigating a Space window to a launcher-scoped
 * `/settings` route would orphan its OS-window label (the tray keys off the
 * label, which is fixed at creation) — see the ADR-0011 "window label tier
 * must match route tier" corollary. A dialog sidesteps navigation entirely.
 *
 * Each control applies optimistically and persists immediately; a persist
 * failure rolls the UI back to the previous value.
 */
function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const { t } = useTranslation(["settings", "common"]);
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [colorTheme, setColorTheme] = useState<ColorTheme>("neutral");
  const [locale, setLocale] = useState<AppSetting["locale"]>("auto");
  const [fontUi, setFontUi] = useState<string>(DEFAULT_FONT);
  const [fontArticle, setFontArticle] = useState<string>(DEFAULT_FONT);
  const [loading, setLoading] = useState(true);

  // ── System font list ────────────────────────────────────────────────
  // Fonts installed on the OS rarely change while the app is open, so an
  // effectively permanent staleTime avoids re-querying on every dialog
  // open. Shared by both font pickers.
  const fontsQuery = useQuery({
    queryKey: ["system-fonts"],
    queryFn: listSystemFonts,
    staleTime: Infinity,
  });
  const systemFonts = fontsQuery.data ?? [];

  useEffect(() => {
    if (fontsQuery.isError) {
      toast.error(i18n.t("settings:font.loadFailed"), {
        description: toErrorPayload(fontsQuery.error).message,
      });
    }
  }, [fontsQuery.isError, fontsQuery.error]);

  // ── Diagnostics state ───────────────────────────────────────────────
  const currentSpaceId = useCurrentSpaceId();
  const [verbosity, setVerbosity] = useState<VerbosityTier>("standard");
  const [verbosityLoading, setVerbosityLoading] = useState(true);

  // Export sub-dialog state.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportSpaceScope, setExportSpaceScope] = useState<"all" | "current">(
    "all",
  );
  const [exportDateRange, setExportDateRange] = useState<
    "last14" | "last24" | "all"
  >("last14");
  const [exporting, setExporting] = useState(false);

  // Clear-logs confirm dialog state.
  const [clearOpen, setClearOpen] = useState(false);
  const [clearing, setClearing] = useState(false);

  const themeOptions: { value: ThemeMode; label: string }[] = [
    { value: "light", label: t("settings:theme.options.light") },
    { value: "dark", label: t("settings:theme.options.dark") },
    { value: "system", label: t("settings:theme.options.system") },
  ];

  const colorOptions: {
    value: ColorTheme;
    label: string;
    swatch: string;
  }[] = [
    { value: "neutral", label: t("settings:color.options.neutral"), swatch: "oklch(0.205 0 0)" },
    { value: "parchment", label: t("settings:color.options.parchment"), swatch: "oklch(0.598 0.135 42)" },
  ];

  const languageOptions: { value: string; label: string }[] = [
    { value: "auto", label: t("settings:language.options.auto") },
    { value: "zh-CN", label: t("settings:language.options.zh-CN") },
    { value: "en", label: t("settings:language.options.en") },
  ];

  useEffect(() => {
    getAppSetting()
      .then((c) => {
        setTheme(c.appearance.theme);
        setColorTheme(c.appearance.colorTheme);
        setLocale(c.locale);
        setFontUi(c.appearance.fontUi ?? DEFAULT_FONT);
        setFontArticle(c.appearance.fontArticle ?? DEFAULT_FONT);
      })
      .catch((e) => {
        // Async catch handler runs outside React's render cycle — use the
        // global `i18n.t` rather than the hook `t` to avoid an
        // exhaustive-deps warning without disabling the rule.
        const payload = toErrorPayload(e);
        toast.error(i18n.t("settings:toast.loadFailed"), {
          description: payload.message,
        });
      })
      .finally(() => setLoading(false));
  }, []);

  // Load the persisted verbosity tier independently of the appearance
  // settings above. Kept separate so the existing locale/theme/color load
  // path stays untouched.
  useEffect(() => {
    getLogLevel()
      .then((tier) => setVerbosity(tier))
      .catch((e) => {
        const payload = toErrorPayload(e);
        toast.error(i18n.t("settings:diagnostics.loadFailed"), {
          description: payload.message,
        });
      })
      .finally(() => setVerbosityLoading(false));
  }, []);

  async function persist(next: {
    theme?: ThemeMode;
    colorTheme?: ColorTheme;
    locale?: AppSetting["locale"];
    fontUi?: string;
    fontArticle?: string;
  }) {
    try {
      await updateAppSetting({
        appearance: {
          theme: next.theme ?? theme,
          colorTheme: next.colorTheme ?? colorTheme,
          fontUi: next.fontUi ?? fontUi,
          fontArticle: next.fontArticle ?? fontArticle,
        },
        locale: next.locale ?? locale,
      });
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(t("settings:toast.saveFailed"), {
        description: payload.message,
      });
      throw e;
    }
  }

  async function handleChangeTheme(next: ThemeMode) {
    if (next === theme) return;
    const prev = theme;
    setTheme(next);
    applyTheme(next);
    try {
      await persist({ theme: next });
    } catch {
      setTheme(prev);
      applyTheme(prev);
    }
  }

  async function handleChangeColor(next: ColorTheme) {
    if (next === colorTheme) return;
    const prev = colorTheme;
    setColorTheme(next);
    applyColorTheme(next);
    try {
      await persist({ colorTheme: next });
    } catch {
      setColorTheme(prev);
      applyColorTheme(prev);
    }
  }

  async function handleChangeUiFont(next: string) {
    if (next === fontUi) return;
    const prev = fontUi;
    setFontUi(next);
    applyUiFont(next);
    try {
      await persist({ fontUi: next });
    } catch {
      setFontUi(prev);
      applyUiFont(prev);
    }
  }

  async function handleChangeArticleFont(next: string) {
    if (next === fontArticle) return;
    const prev = fontArticle;
    setFontArticle(next);
    applyArticleFont(next);
    try {
      await persist({ fontArticle: next });
    } catch {
      setFontArticle(prev);
      applyArticleFont(prev);
    }
  }

  async function handleChangeLanguage(next: AppSetting["locale"]) {
    if (next === locale) return;
    const prev = locale;

    // Resolve the previous locale for rollback. `i18n.language` already
    // holds the resolved SupportedLocale from bootstrap or the previous
    // changeLanguage call, so it's the right value to revert to.
    let prevResolved: string = prev;
    if (prev === AUTO_LOCALE) {
      try {
        const os = await detectOsLocale();
        prevResolved = os ? resolveLocale(os) : i18n.language;
      } catch {
        prevResolved = i18n.language;
      }
    }

    setLocale(next);
    let resolved: string;
    if (next === AUTO_LOCALE) {
      try {
        const os = await detectOsLocale();
        resolved = os ? resolveLocale(os) : i18n.language;
      } catch {
        resolved = i18n.language;
      }
    } else {
      resolved = resolveLocale(next);
    }

    await i18n.changeLanguage(resolved);
    setDayjsLocale(resolved);
    setTrayLocale(resolved).catch((e) =>
      logger.warn("settings.set_tray_locale.failed", {
        locale: resolved,
        error: String(e),
      }),
    );

    try {
      await persist({ locale: next });
    } catch {
      setLocale(prev);
      await i18n.changeLanguage(prevResolved);
      setDayjsLocale(prevResolved);
      setTrayLocale(prevResolved).catch((e) =>
        logger.warn("settings.set_tray_locale.failed", {
          locale: prevResolved,
          error: String(e),
        }),
      );
    }
  }

  // ── Diagnostics handlers ────────────────────────────────────────────

  async function handleChangeVerbosity(next: VerbosityTier) {
    if (next === verbosity) return;
    const prev = verbosity;
    setVerbosity(next);
    // Mirror into the frontend threshold immediately so the drop decision
    // changes on this render cycle — do NOT wait for the Tauri
    // `log-level-changed` event round-trip (that listener exists for
    // cross-window sync, not for the originating window).
    setLevel(verbosityToLogLevel(next));
    try {
      await setLogLevel(next);
    } catch {
      // Roll back both the UI selection and the threshold.
      setVerbosity(prev);
      setLevel(verbosityToLogLevel(prev));
      const msg = i18n.t("settings:toast.saveFailed");
      toast.error(msg);
    }
  }

  async function handleOpenFolder() {
    try {
      const dir = await getLogsDir();
      await openPath(dir);
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(i18n.t("settings:diagnostics.openFolderFailed"), {
        description: payload.message,
      });
    }
  }

  function handleOpenExport() {
    // Default the Space scope to "current" when the dialog is opened from
    // within a Space route; otherwise fall back to "all Spaces" (and the
    // "current" option is disabled in the UI).
    setExportSpaceScope(currentSpaceId ? "current" : "all");
    setExportDateRange("last14");
    setExportOpen(true);
  }

  async function handleConfirmExport() {
    // Pop a native directory picker so the user chooses the destination,
    // instead of silently dumping into the downloads folder. Default the
    // picker to the downloads folder as a sensible starting point.
    let defaultPath: string;
    try {
      defaultPath = await downloadDir();
    } catch {
      defaultPath = "";
    }
    const picked = await openDialog({ directory: true, defaultPath });
    // `null` = dismissed; an array only happens with `multiple: true` (not
    // set). Either way, anything that isn't a single string path = cancel:
    // keep the options sub-dialog open (no error toast) so the user can retry.
    if (typeof picked !== "string") return;

    setExporting(true);
    try {
      // Include HH-mm so same-day exports don't silently overwrite. Two
      // exports within the same minute are still treated as the same file
      // (intentional — avoids clutter from rapid double-clicks).
      const stamp = dayjs().format("YYYY-MM-DD_HH-mm");
      const filename = `sluver-logs-${stamp}.zip`;
      const outputPath = await join(picked, filename);
      const range: DateRange =
        exportDateRange === "last14"
          ? dateRange.lastNDays(14)
          : exportDateRange === "last24"
            ? dateRange.last24Hours()
            : dateRange.all();
      const spaceIdFilter =
        exportSpaceScope === "current" ? currentSpaceId : null;
      await exportLogs({ outputPath, spaceIdFilter, dateRange: range });
      setExportOpen(false);
      toast.success(i18n.t("settings:diagnostics.export.success", { path: outputPath }));
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(i18n.t("settings:diagnostics.export.failed"), {
        description: payload.message,
      });
    } finally {
      setExporting(false);
    }
  }

  async function handleConfirmClear() {
    setClearing(true);
    try {
      const count = await clearLogs();
      setClearOpen(false);
      toast.success(
        i18n.t("settings:diagnostics.clear.success", { count }),
      );
    } catch (e) {
      const payload = toErrorPayload(e);
      toast.error(i18n.t("settings:diagnostics.clear.failed"), {
        description: payload.message,
      });
    } finally {
      setClearing(false);
    }
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-lg">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("settings:title")}</DialogTitle>
            <DialogDescription>
              {t("settings:subtitle", { app: "sluver" })}
            </DialogDescription>
          </DialogHeader>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
            <section className="flex flex-col divide-y divide-border border-y border-border">
              <SettingRow
                title={t("settings:theme.title")}
                description={t("settings:theme.description")}
              >
                <Segmented
                  ariaLabel={t("settings:theme.title")}
                  loading={loading}
                  options={themeOptions}
                  value={theme}
                  onChange={(v) => handleChangeTheme(v as ThemeMode)}
                />
              </SettingRow>

              <SettingRow
                title={t("settings:color.title")}
                description={t("settings:color.description")}
              >
                <Segmented
                  ariaLabel={t("settings:color.title")}
                  loading={loading}
                  options={colorOptions}
                  value={colorTheme}
                  onChange={(v) => handleChangeColor(v as ColorTheme)}
                  renderLabel={(opt) => (
                    <span className="flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="size-2.5 rounded-full ring-1 ring-inset ring-black/10"
                        style={{ backgroundColor: opt.swatch }}
                      />
                      {opt.label}
                    </span>
                  )}
                />
              </SettingRow>

              <SettingRow
                title={t("settings:language.title")}
                description={t("settings:language.description")}
              >
                <Segmented
                  ariaLabel={t("settings:language.title")}
                  loading={loading}
                  options={languageOptions}
                  value={locale}
                  onChange={(v) => handleChangeLanguage(v as AppSetting["locale"])}
                />
              </SettingRow>

              <SettingRow
                title={t("settings:font.ui.title")}
                description={t("settings:font.ui.description")}
              >
                <FontCombobox
                  ariaLabel={t("settings:font.ui.title")}
                  value={fontUi}
                  fonts={systemFonts}
                  loading={loading || fontsQuery.isPending}
                  placeholder={t("settings:font.placeholder")}
                  defaultLabel={t("settings:font.default")}
                  emptyLabel={t("settings:font.empty")}
                  onSelect={handleChangeUiFont}
                />
              </SettingRow>

              <SettingRow
                title={t("settings:font.article.title")}
                description={t("settings:font.article.description")}
              >
                <FontCombobox
                  ariaLabel={t("settings:font.article.title")}
                  value={fontArticle}
                  fonts={systemFonts}
                  loading={loading || fontsQuery.isPending}
                  placeholder={t("settings:font.placeholder")}
                  defaultLabel={t("settings:font.default")}
                  emptyLabel={t("settings:font.empty")}
                  onSelect={handleChangeArticleFont}
                />
              </SettingRow>
            </section>

            {/* ── Diagnostics ──────────────────────────────────────────── */}
            <section className="flex flex-col gap-3 border-t border-border pt-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("settings:diagnostics.title")}
              </p>

              <div className="flex items-start justify-between gap-6">
                <div className="flex flex-col gap-0.5">
                  <p className="text-sm font-medium">
                    {t("settings:diagnostics.verbosity.label")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t("settings:diagnostics.verbosity.help")}
                  </p>
                </div>
                <Select
                  value={verbosity}
                  onValueChange={(v) => {
                    if (typeof v === "string") {
                      handleChangeVerbosity(v as VerbosityTier);
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-32 shrink-0"
                    disabled={verbosityLoading}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectList>
                      <SelectItem value="standard">
                        <SelectItemText>
                          {t("settings:diagnostics.verbosity.standard")}
                        </SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                      <SelectItem value="verbose">
                        <SelectItemText>
                          {t("settings:diagnostics.verbosity.verbose")}
                        </SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                      <SelectItem value="very_verbose">
                        <SelectItemText>
                          {t("settings:diagnostics.verbosity.veryVerbose")}
                        </SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                    </SelectList>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex flex-col gap-2">
                <Button
                  variant="outline"
                  onClick={handleOpenFolder}
                  className="justify-start"
                >
                  {t("settings:diagnostics.openFolder")}
                </Button>
                <Button
                  variant="outline"
                  onClick={handleOpenExport}
                  className="justify-start"
                >
                  {t("settings:diagnostics.export.button")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => setClearOpen(true)}
                  className="justify-start text-destructive hover:text-destructive"
                >
                  {t("settings:diagnostics.clear.button")}
                </Button>
              </div>
            </section>
          </div>

          <DialogFooter className="mt-4 shrink-0">
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.done")}
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Export logs sub-dialog ─────────────────────────────────── */}
      <Dialog open={exportOpen} onOpenChange={setExportOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t("settings:diagnostics.export.dialogTitle")}
            </DialogTitle>
          </DialogHeader>

          <div className="flex flex-col gap-4">
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium">
                {t("settings:diagnostics.export.spaceScope")}
              </legend>
              <RadioCard
                active={exportSpaceScope === "all"}
                label={t("settings:diagnostics.export.allSpaces")}
                onSelect={() => setExportSpaceScope("all")}
              />
              <RadioCard
                active={exportSpaceScope === "current"}
                disabled={!currentSpaceId}
                label={t("settings:diagnostics.export.currentSpace")}
                onSelect={() => setExportSpaceScope("current")}
              />
            </fieldset>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-xs font-medium">
                {t("settings:diagnostics.export.dateRange")}
              </legend>
              <RadioCard
                active={exportDateRange === "last14"}
                label={t("settings:diagnostics.export.last14Days")}
                onSelect={() => setExportDateRange("last14")}
              />
              <RadioCard
                active={exportDateRange === "last24"}
                label={t("settings:diagnostics.export.last24Hours")}
                onSelect={() => setExportDateRange("last24")}
              />
              <RadioCard
                active={exportDateRange === "all"}
                label={t("settings:diagnostics.export.allDates")}
                onSelect={() => setExportDateRange("all")}
              />
            </fieldset>
          </div>

          <DialogFooter>
            <DialogClose render={<Button variant="outline" type="button" />}>
              {t("common:actions.cancel")}
            </DialogClose>
            <Button
              onClick={handleConfirmExport}
              disabled={exporting}
            >
              {exporting
                ? t("settings:diagnostics.export.exporting")
                : t("settings:diagnostics.export.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Clear logs confirm ─────────────────────────────────────── */}
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("settings:diagnostics.clear.confirmTitle")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("settings:diagnostics.clear.confirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={handleConfirmClear}
              disabled={clearing}
            >
              {clearing
                ? t("settings:diagnostics.clear.clearing")
                : t("settings:diagnostics.clear.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-5">
      <div className="flex flex-col gap-0.5">
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      {children}
    </div>
  );
}

interface SegmentedProps<T extends { value: string; label: string }> {
  ariaLabel: string;
  loading: boolean;
  options: T[];
  value: string;
  onChange: (value: string) => void;
  renderLabel?: (opt: T) => React.ReactNode;
}

function Segmented<T extends { value: string; label: string }>({
  ariaLabel,
  loading,
  options,
  value,
  onChange,
  renderLabel,
}: SegmentedProps<T>) {
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className="inline-flex shrink-0 items-center gap-0.5 rounded-md border border-border bg-muted p-0.5"
    >
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={loading}
            onClick={() => onChange(opt.value)}
            className={cn(
              "rounded-sm px-3 py-1 text-xs font-medium outline-none transition-colors",
              "focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {renderLabel ? renderLabel(opt) : opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A single vertical radio option with a circular indicator. Used inside
 * the export sub-dialog for the Space-scope and date-range choices where
 * a horizontal `Segmented` control would be too wide for the narrow dialog.
 */
function RadioCard({
  active,
  disabled,
  label,
  onSelect,
}: {
  active: boolean;
  disabled?: boolean;
  label: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex items-center gap-2 rounded-md border px-3 py-2 text-left text-xs font-medium outline-none transition-colors",
        "focus-visible:ring-2 focus-visible:ring-ring/30",
        active
          ? "border-border bg-muted text-foreground"
          : "border-transparent text-muted-foreground hover:bg-muted/50 hover:text-foreground",
        disabled && "pointer-events-none opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
          active ? "border-foreground" : "border-muted-foreground/40",
        )}
      >
        {active && <span className="size-1.5 rounded-full bg-foreground" />}
      </span>
      <span>{label}</span>
    </button>
  );
}

/**
 * Searchable single-select combobox for font family picking — a Popover +
 * Command (cmdk) combo rather than a plain Select because system font lists
 * run into the hundreds and need filtering.
 *
 * Options are the "default" sentinel (app default font) plus the supplied
 * system fonts, each rendered in its own family as a live preview. Selection
 * is reported up via `onSelect`; persistence/rollback is owned by the parent
 * (same optimistic pattern as the theme/color rows).
 *
 * Note: `onSelect` closes over the option name directly rather than using
 * cmdk's callback argument — the closed-over name is the exact persisted
 * setting value, avoiding any reliance on cmdk's argument semantics.
 */
function FontCombobox({
  ariaLabel,
  value,
  fonts,
  loading,
  placeholder,
  defaultLabel,
  emptyLabel,
  onSelect,
}: {
  ariaLabel: string;
  /** Persisted setting value — "default" sentinel or a font family name. */
  value: string;
  fonts: string[];
  loading: boolean;
  placeholder: string;
  defaultLabel: string;
  emptyLabel: string;
  onSelect: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label = value === DEFAULT_FONT ? defaultLabel : value;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            type="button"
            role="combobox"
            aria-label={ariaLabel}
            aria-expanded={open}
            disabled={loading}
            className="w-56 justify-between font-normal"
          />
        }
      >
        <span
          className="min-w-0 flex-1 truncate text-left"
          style={{ fontFamily: fontStack(value) }}
        >
          {label}
        </span>
        <HugeiconsIcon
          icon={ChevronDownIcon}
          strokeWidth={2}
          data-icon="inline-end"
          className="shrink-0 opacity-50"
        />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 p-0">
        <Command>
          <CommandInput placeholder={placeholder} />
          <CommandList>
            <CommandEmpty>{emptyLabel}</CommandEmpty>
            <CommandGroup>
              <CommandItem
                value={DEFAULT_FONT}
                data-checked={value === DEFAULT_FONT || undefined}
                onSelect={() => {
                  onSelect(DEFAULT_FONT);
                  setOpen(false);
                }}
              >
                {defaultLabel}
              </CommandItem>
              {fonts.map((name) => (
                <CommandItem
                  key={name}
                  value={name}
                  data-checked={name === value || undefined}
                  onSelect={() => {
                    onSelect(name);
                    setOpen(false);
                  }}
                  style={{ fontFamily: fontStack(name) }}
                >
                  <span className="min-w-0 flex-1 truncate">{name}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export { SettingsDialog };
