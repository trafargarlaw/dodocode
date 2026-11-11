import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme, shell } from "electron";
import { TITLE_BAR_HEIGHT, WINDOW_THEME_CHANNEL, type WindowTheme } from "../preload/bridge";

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;
// The page draws the title bar's background, so the window buttons sit on a clear overlay.
const CLEAR = "#00000000";

function isWindowTheme(value: unknown): value is WindowTheme {
  if (typeof value !== "object" || value === null) return false;
  const { appearance, symbolColor } = value as Record<string, unknown>;
  return (
    (appearance === "system" || appearance === "light" || appearance === "dark") &&
    typeof symbolColor === "string" &&
    /^#[\da-f]{6}$/i.test(symbolColor)
  );
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

function createMainWindow(): void {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 800,
    minHeight: 500,
    show: false,
    title: "dodocode",
    // The page draws the title bar. macOS keeps its traffic lights, centred in it; Windows and
    // Linux keep their window buttons, drawn over it.
    titleBarStyle: "hidden",
    ...(process.platform === "darwin"
      ? { trafficLightPosition: { x: 14, y: (TITLE_BAR_HEIGHT - 16) / 2 } }
      : { titleBarOverlay: { color: CLEAR, height: TITLE_BAR_HEIGHT } }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Links that open a new window go to the system browser; the app never opens its own popups.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isWebUrl(url)) void shell.openExternal(url);
    return { action: "deny" };
  });

  // The app window only ever shows the app itself.
  window.webContents.on("will-navigate", (event) => event.preventDefault());

  if (rendererDevUrl) {
    void window.loadURL(rendererDevUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
}

// The page sends its theme each time it changes, for the parts of the window it cannot draw.
ipcMain.on(WINDOW_THEME_CHANNEL, (event, theme: unknown) => {
  if (!isWindowTheme(theme)) return;
  nativeTheme.themeSource = theme.appearance;
  if (process.platform === "darwin") return;
  BrowserWindow.fromWebContents(event.sender)?.setTitleBarOverlay({
    color: CLEAR,
    symbolColor: theme.symbolColor,
    height: TITLE_BAR_HEIGHT,
  });
});

void app.whenReady().then(() => {
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
