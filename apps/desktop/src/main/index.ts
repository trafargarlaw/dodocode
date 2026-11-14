import { stat } from "node:fs/promises";
import { join } from "node:path";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import windowsIcon from "../../build/icon.ico?asset";
import linuxIcon from "../../build/icons/256x256.png?asset";
import {
  OPEN_FOLDER_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SERVER_INFO_CHANNEL,
  TITLE_BAR_HEIGHT,
  WINDOW_THEME_CHANNEL,
  type WindowTheme,
} from "../preload/bridge";
import { ServerProcess } from "./server-process";
import { TraceRecorder, traceSettings } from "./tracing";

// A development build keeps its projects, threads and settings apart from the installed app's,
// so the two can run side by side.
const dev = !app.isPackaged;
if (dev) app.setPath("userData", `${app.getPath("userData")}-dev`);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

// Set DODOCODE_TRACE to record a performance trace: see tracing.ts.
const trace = traceSettings();
const recorder = trace ? new TraceRecorder(trace) : undefined;

const server = new ServerProcess(recorder?.serverProfile);

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

async function createMainWindow(): Promise<void> {
  // Only the first window is recorded. A later one, as macOS opens after the last one closes,
  // neither marks spans for a trace nor waits on one to close.
  const traced = recorder?.waiting ? recorder : undefined;
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
      additionalArguments: [
        ...(dev ? ["--dodocode-dev"] : []),
        ...(traced ? ["--dodocode-trace"] : []),
      ],
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

  if (traced) {
    // The trace is written while the window is still open: the recording needs its page.
    window.on("close", (event) => {
      if (traced.finished) return;
      event.preventDefault();
      void traced.stop().finally(() => window.close());
    });
    await traced.attach(window.webContents);
  }

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

// Only a folder: the system would run a program it was given, rather than show it.
ipcMain.handle(OPEN_FOLDER_CHANNEL, async (_event, path: unknown) => {
  if (typeof path !== "string" || !path) return "No folder was given.";
  const found = await stat(path).catch(() => undefined);
  if (!found?.isDirectory()) return `${path} is not a folder, or is gone.`;
  return shell.openPath(path);
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
  void createMainWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The server finishes writing and stops its agents before the app exits, and a trace being
// recorded is written.
let serverStopped = false;
app.on("before-quit", (event) => {
  if (serverStopped) return;
  event.preventDefault();
  void Promise.all([recorder?.stop(), server.stop()]).finally(() => {
    serverStopped = true;
    app.quit();
  });
});
