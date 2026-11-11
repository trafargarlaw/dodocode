import { contextBridge } from "electron";
import type { DodocodeBridge } from "./bridge";

const bridge: DodocodeBridge = {
  platform: process.platform,
};

contextBridge.exposeInMainWorld("dodocode", bridge);
