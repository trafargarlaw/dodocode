import { contextBridge, ipcRenderer } from "electron";
import {
  PICK_FOLDER_CHANNEL,
  SERVER_INFO_CHANNEL,
  WINDOW_THEME_CHANNEL,
  type DodocodeBridge,
} from "./bridge";

const bridge: DodocodeBridge = {
  platform: process.platform,
  dev: process.argv.includes("--dodocode-dev"),
  setWindowTheme: (theme) => ipcRenderer.send(WINDOW_THEME_CHANNEL, theme),
  serverInfo: () => ipcRenderer.invoke(SERVER_INFO_CHANNEL),
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
};

contextBridge.exposeInMainWorld("dodocode", bridge);
