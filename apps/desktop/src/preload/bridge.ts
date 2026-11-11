// What the preload exposes to the renderer as `window.dodocode`.
// Types only, so the renderer can import it without pulling in Electron.
export interface DodocodeBridge {
  platform: string;
}
