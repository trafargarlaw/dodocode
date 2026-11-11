import { useSyncExternalStore } from "react";
import {
  deriveTheme,
  parseThemeSettings,
  type ColorScheme,
  type Theme,
  type ThemeSettings,
} from "@dodocode/ui/lib/theme";

export interface ThemeState {
  settings: ThemeSettings;
  theme: Theme;
}

const STORAGE_KEY = "dodocode.theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const listeners = new Set<() => void>();
let state: ThemeState | undefined;
let onApply: ((state: ThemeState) => void) | undefined;

systemDark.addEventListener("change", () => {
  if (state?.settings.appearance === "system") commit(state.settings);
});

/**
 * Loads the saved theme and applies it to the page. Call it once before the first render, so the
 * first frame already has the theme. `onApply` runs each time the theme changes, for colours that
 * live outside the page, such as the window buttons.
 */
export function startTheme(options: { onApply?: (state: ThemeState) => void } = {}): void {
  onApply = options.onApply;
  commit(load());
}

/** Applies new settings and saves them. */
export function setTheme(next: ThemeSettings | ((current: ThemeSettings) => ThemeSettings)): void {
  const settings = typeof next === "function" ? next(current().settings) : next;
  commit(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Storage is full or blocked: the theme still applies for this session.
  }
}

export function useTheme(): ThemeState {
  return useSyncExternalStore(subscribe, current);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function current(): ThemeState {
  // Started late, from the first render: nothing has subscribed yet, so nothing is notified.
  if (!state) commit(load());
  return state as ThemeState;
}

function load(): ThemeSettings {
  try {
    return parseThemeSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null"));
  } catch {
    return parseThemeSettings(null);
  }
}

function commit(settings: ThemeSettings): void {
  const scheme: ColorScheme =
    settings.appearance === "system"
      ? systemDark.matches
        ? "dark"
        : "light"
      : settings.appearance;
  state = { settings, theme: deriveTheme(settings, scheme) };
  applyToDocument(state.theme);
  onApply?.(state);
  for (const listener of listeners) listener();
}

function applyToDocument(theme: Theme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme.scheme === "dark");
  root.style.colorScheme = theme.scheme;
  const variables: Record<string, string> = {
    "--wallpaper": theme.wallpaper,
    "--sidebar-foreground": theme.text,
    "--sidebar-muted-foreground": theme.mutedText,
    "--sidebar-accent": theme.hover,
    "--sidebar-accent-foreground": theme.text,
    "--sidebar-selected": theme.selected,
    "--sidebar-border": theme.border,
    "--sidebar-primary": theme.primary,
    "--sidebar-primary-foreground": theme.primaryForeground,
    "--sidebar-ring": theme.primaryInk,
    "--primary": theme.primary,
    "--primary-foreground": theme.primaryForeground,
    "--primary-ink": theme.primaryInk,
    "--ring": theme.primaryInk,
  };
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
}
