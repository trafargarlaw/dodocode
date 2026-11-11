// What the preload exposes to the renderer as `window.dodocode`.
// No Electron imports, so the renderer can import it without pulling in Electron.

/** The title bar's height in pixels. The window buttons on Windows and Linux are this tall. */
export const TITLE_BAR_HEIGHT = 40;

/** The IPC channel the renderer sends a `WindowTheme` on. */
export const WINDOW_THEME_CHANNEL = "window:theme";

/** The colours of the parts of the window that the page cannot draw. */
export interface WindowTheme {
  /** For the system's own menus and dialogs. */
  appearance: "system" | "light" | "dark";
  /** The window buttons' colour on Windows and Linux, as `#rrggbb`. */
  symbolColor: string;
}

export interface DodocodeBridge {
  platform: string;
  setWindowTheme(theme: WindowTheme): void;
}
