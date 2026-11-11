import { contextBridge, ipcRenderer } from "electron";
import { WINDOW_THEME_CHANNEL, type DodocodeBridge } from "./bridge";

const bridge: DodocodeBridge = {
  platform: process.platform,
  setWindowTheme: (theme) => ipcRenderer.send(WINDOW_THEME_CHANNEL, theme),
};

contextBridge.exposeInMainWorld("dodocode", bridge);
