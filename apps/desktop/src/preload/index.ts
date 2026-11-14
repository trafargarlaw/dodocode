import { contextBridge, ipcRenderer } from "electron";
import {
  OPEN_FOLDER_CHANNEL,
  PICK_FOLDER_CHANNEL,
  SERVER_INFO_CHANNEL,
  WINDOW_THEME_CHANNEL,
  type DodocodeBridge,
} from "./bridge";

const bridge: DodocodeBridge = {
  platform: process.platform,
  dev: process.argv.includes("--dodocode-dev"),
  tracing: process.argv.includes("--dodocode-trace"),
  setWindowTheme: (theme) => ipcRenderer.send(WINDOW_THEME_CHANNEL, theme),
  serverInfo: () => ipcRenderer.invoke(SERVER_INFO_CHANNEL),
  pickFolder: (defaultPath) => ipcRenderer.invoke(PICK_FOLDER_CHANNEL, defaultPath),
  openFolder: (path) => ipcRenderer.invoke(OPEN_FOLDER_CHANNEL, path),
};

contextBridge.exposeInMainWorld("dodocode", bridge);
