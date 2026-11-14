import { defineAppHotkeys, type CustomHotkeys } from "@tanstack/react-hotkeys";

// Every keyboard shortcut in the app, declared once. The shortcuts dialog lists them and lets
// people rebind them. The ids key people's saved bindings: renaming one drops what they saved.
export const appHotkeys = defineAppHotkeys({
  "search.open": {
    hotkey: "Mod+K",
    meta: { name: "Search", group: "General" },
  },
  "thread.new": {
    hotkey: "Mod+N",
    meta: { name: "New thread", group: "General" },
  },
  "board.open": {
    hotkey: ["G", "B"],
    meta: { name: "Open the board", group: "General" },
  },
  "shortcuts.open": {
    hotkey: "Mod+/",
    meta: { name: "Keyboard shortcuts", group: "General" },
    options: { requireReset: true },
  },
  "sidebar.toggle": {
    hotkey: "Mod+B",
    meta: { name: "Show or hide the sidebar", group: "Window" },
    options: { requireReset: true },
  },
  "details.toggle": {
    hotkey: "Mod+I",
    meta: { name: "Show or hide the thread's details", group: "Window" },
    options: { requireReset: true },
  },
  "panel.toggle": {
    hotkey: "Mod+Alt+B",
    meta: { name: "Show or hide the panel beside the thread", group: "Window" },
    options: { requireReset: true },
  },
  "panel.full": {
    hotkey: "Mod+Alt+F",
    meta: { name: "Let the panel take the whole page, or give it back", group: "Window" },
    options: { requireReset: true },
  },
  "appearance.toggle": {
    hotkey: "Mod+Shift+L",
    meta: { name: "Switch between light and dark", group: "Window" },
    options: { requireReset: true },
  },
  "theme.open": {
    hotkey: ["G", "T"],
    meta: { name: "Open the theme", group: "Theme" },
  },
  // The two keys side by side step left and right, whatever they type on the keyboard's layout.
  "theme.previousPreset": {
    hotkey: "[BracketLeft]",
    meta: { name: "Previous preset", description: "While the theme is open", group: "Theme" },
    scope: "theme",
  },
  "theme.nextPreset": {
    hotkey: "[BracketRight]",
    meta: { name: "Next preset", description: "While the theme is open", group: "Theme" },
    scope: "theme",
  },
});

declare module "@tanstack/react-hotkeys" {
  interface Register {
    appHotkeys: typeof appHotkeys;
  }
}

const STORAGE_KEY = "dodocode.hotkeys";

/** The bindings people changed, as saved. The provider drops ids and keys it does not know. */
export function loadCustomHotkeys(): CustomHotkeys {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    return typeof saved === "object" && saved !== null ? (saved as CustomHotkeys) : {};
  } catch {
    return {};
  }
}

export function saveCustomHotkeys(custom: CustomHotkeys): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(custom));
  } catch {
    // Storage can be full or blocked; the bindings still apply until the app closes.
  }
}
