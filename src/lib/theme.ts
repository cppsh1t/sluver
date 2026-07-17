import type { AppSetting } from "@/types";

export type ThemeMode = AppSetting["appearance"]["theme"];
export type ColorTheme = AppSetting["appearance"]["colorTheme"];

function systemPrefersDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Resolve a ThemeMode to the concrete class to apply right now. */
function resolvesToDark(mode: ThemeMode): boolean {
  return mode === "dark" || (mode === "system" && systemPrefersDark());
}

/**
 * Apply a theme mode to the document root by toggling the `.dark` class.
 * Call on app load and whenever the user changes the setting.
 */
export function applyTheme(mode: ThemeMode): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolvesToDark(mode));
}

/**
 * Apply a color theme via the `data-color-theme` attribute. "neutral" clears
 * the attribute (falls back to the default palette).
 */
export function applyColorTheme(colorTheme: ColorTheme): void {
  const root = document.documentElement;
  if (colorTheme === "neutral") {
    root.removeAttribute("data-color-theme");
  } else {
    root.setAttribute("data-color-theme", colorTheme);
  }
}

/**
 * Subscribe to OS color-scheme changes. Only relevant while mode === "system".
 * Returns an unsubscribe function.
 */
export function watchSystemTheme(onChange: () => void): () => void {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => onChange();
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}
