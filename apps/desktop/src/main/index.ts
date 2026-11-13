import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import windowsIcon from "../../build/icon.ico?asset";
import linuxIcon from "../../build/icons/256x256.png?asset";
import {
  PICK_FOLDER_CHANNEL,
  SERVER_INFO_CHANNEL,
  TITLE_BAR_HEIGHT,
  WINDOW_THEME_CHANNEL,
  type WindowTheme,
} from "../preload/bridge";
import { ServerProcess } from "./server-process";

// A development build keeps its projects, threads and settings apart from the installed app's,
// so the two can run side by side.
const dev = !app.isPackaged;
if (dev) app.setPath("userData", `${app.getPath("userData")}-dev`);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const server = new ServerProcess();

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL;
// The page draws the title bar's background, so the window buttons sit on a clear overlay.
const CLEAR = "#00000000";

// macOS shows the icon in the app bundle. Windows and Linux show the window's own, which also
// stands in for Electron's icon while developing.
const windowIcon =
  process.platform === "win32" ? windowsIcon : process.platform === "linux" ? linuxIcon : null;

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
    ...(windowIcon ? { icon: windowIcon } : {}),
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
      additionalArguments: dev ? ["--dodocode-dev"] : [],
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

ipcMain.handle(SERVER_INFO_CHANNEL, () => server.info());

ipcMain.handle(PICK_FOLDER_CHANNEL, async (event, defaultPath: unknown) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  const options = {
    properties: ["openDirectory" as const, "createDirectory" as const],
    ...(typeof defaultPath === "string" && defaultPath ? { defaultPath } : {}),
  };
  const result = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
});

// A second launch shows the window that is already open.
app.on("second-instance", () => {
  const [window] = BrowserWindow.getAllWindows();
  if (!window) return;
  if (window.isMinimized()) window.restore();
  window.focus();
});

void app.whenReady().then(() => {
  server.start();
  createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The server finishes writing and stops its agents before the app exits.
let serverStopped = false;
app.on("before-quit", (event) => {
  if (serverStopped) return;
  event.preventDefault();
  void server.stop().finally(() => {
    serverStopped = true;
    app.quit();
  });
});
