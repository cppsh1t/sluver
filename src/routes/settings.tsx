import { useEffect, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { toast } from "sonner";

import { rootRoute } from "./__root";
import { getAppConfig, updateAppConfig } from "@/api";
import {
  applyColorTheme,
  applyTheme,
  type ColorTheme,
  type ThemeMode,
} from "@/lib/theme";
import { cn } from "@/lib/utils";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: "light", label: "浅色" },
  { value: "dark", label: "深色" },
  { value: "system", label: "跟随系统" },
];

const COLOR_OPTIONS: {
  value: ColorTheme;
  label: string;
  /** Representative swatch color for the option. */
  swatch: string;
}[] = [
  { value: "neutral", label: "默认", swatch: "oklch(0.205 0 0)" },
  { value: "parchment", label: "羊皮纸", swatch: "oklch(0.598 0.135 42)" },
];

function SettingsPage() {
  const [theme, setTheme] = useState<ThemeMode>("system");
  const [colorTheme, setColorTheme] = useState<ColorTheme>("neutral");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getAppConfig()
      .then((c) => {
        setTheme(c.appearance.theme);
        setColorTheme(c.appearance.colorTheme);
      })
      .catch((e) => toast.error("加载配置失败", { description: e as string }))
      .finally(() => setLoading(false));
  }, []);

  async function persist(next: {
    theme?: ThemeMode;
    colorTheme?: ColorTheme;
  }) {
    try {
      await updateAppConfig({
        appearance: {
          theme: next.theme ?? theme,
          colorTheme: next.colorTheme ?? colorTheme,
        },
      });
    } catch (e) {
      toast.error("保存失败", { description: e as string });
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

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-6 py-10">
        <header className="mb-8">
          <h1 className="font-heading text-xl font-semibold tracking-tight">
            配置
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            调整 sluver 的外观与行为。
          </p>
        </header>

        <section className="flex flex-col divide-y divide-border border-y border-border">
          <SettingRow
            title="外观"
            description="选择浅色或深色。「跟随系统」会随操作系统的深浅色自动切换。"
          >
            <Segmented
              ariaLabel="外观"
              loading={loading}
              options={THEME_OPTIONS}
              value={theme}
              onChange={(v) => handleChangeTheme(v as ThemeMode)}
            />
          </SettingRow>

          <SettingRow title="配色" description="为界面选择一套色彩主题。">
            <Segmented
              ariaLabel="配色"
              loading={loading}
              options={COLOR_OPTIONS}
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
        </section>
      </div>
    </div>
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

export const settingsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/settings",
  component: SettingsPage,
});
