import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { locale as detectOsLocale } from "@tauri-apps/plugin-os";

import { resolveLocale, AUTO_LOCALE } from "@/i18n";
import i18n from "@/i18n";
import { getAppSetting, setTrayLocale, updateAppSetting } from "@/api";
import { toErrorPayload } from "@/api/client";
import { setDayjsLocale } from "@/lib/format";
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
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
  const [loading, setLoading] = useState(true);

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

  async function persist(next: {
    theme?: ThemeMode;
    colorTheme?: ColorTheme;
    locale?: AppSetting["locale"];
  }) {
    try {
      await updateAppSetting({
        appearance: {
          theme: next.theme ?? theme,
          colorTheme: next.colorTheme ?? colorTheme,
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
    setTrayLocale(resolved).catch(() => {});

    try {
      await persist({ locale: next });
    } catch {
      setLocale(prev);
      await i18n.changeLanguage(prevResolved);
      setDayjsLocale(prevResolved);
      setTrayLocale(prevResolved).catch(() => {});
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("settings:title")}</DialogTitle>
          <DialogDescription>
            {t("settings:subtitle", { app: "sluver" })}
          </DialogDescription>
        </DialogHeader>

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
        </section>

        <DialogFooter className="mt-4">
          <DialogClose render={<Button variant="outline" type="button" />}>
            {t("common:actions.done")}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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

export { SettingsDialog };
