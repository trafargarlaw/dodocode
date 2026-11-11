/// <reference types="vite/client" />

import type { DodocodeBridge } from "../preload/bridge";

declare global {
  interface Window {
    dodocode: DodocodeBridge;
  }
}
