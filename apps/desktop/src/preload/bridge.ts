// What the preload exposes to the renderer as `window.dodocode`.
// No Electron imports, so the renderer can import it without pulling in Electron.

/** The title bar's height in pixels. The window buttons on Windows and Linux are this tall. */
export const TITLE_BAR_HEIGHT = 40;

/** The IPC channel the renderer sends a `WindowTheme` on. */
export const WINDOW_THEME_CHANNEL = "window:theme";
/** The IPC channel the renderer asks for the server's address on. */
export const SERVER_INFO_CHANNEL = "server:info";
/** The IPC channel the renderer asks the system's folder picker on. */
export const PICK_FOLDER_CHANNEL = "dialog:pick-folder";

/** The colours of the parts of the window that the page cannot draw. */
export interface WindowTheme {
  /** For the system's own menus and dialogs. */
  appearance: "system" | "light" | "dark";
  /** The window buttons' colour on Windows and Linux, as `#rrggbb`. */
  symbolColor: string;
}

/** Where the dodocode server listens, and the token every request carries. */
export interface ServerInfo {
  /** The WebSocket address, without the token. */
  url: string;
  /** The HTTP address that serves attachments. */
  httpUrl: string;
  token: string;
}

export interface DodocodeBridge {
  platform: string;
  /** True in a build made with `electron-vite dev`, which keeps its data apart. */
  dev: boolean;
  /** True while the app records a performance trace (DODOCODE_TRACE): see renderer/perf.ts. */
  tracing: boolean;
  setWindowTheme(theme: WindowTheme): void;
  /** Resolves once the server listens, which can take a moment after a restart. */
  serverInfo(): Promise<ServerInfo>;
  /**
   * Shows the system's folder picker, open at `defaultPath` when given. Resolves to null when it
   * is cancelled.
   */
  pickFolder(defaultPath?: string): Promise<string | null>;
}
