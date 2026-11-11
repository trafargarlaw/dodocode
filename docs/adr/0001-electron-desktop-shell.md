# Electron is the desktop shell

dodocode must run on macOS, Windows and Linux, and the agent must control a browser preview inside the app. To control the preview, the app uses the Chrome DevTools Protocol, as T3 Code does. Electron gives the same Chromium engine and the DevTools Protocol on all three systems, so we use Electron.

## Considered options

- **Tauri 2.** Tauri 2 uses the webview of the system. On macOS this is WKWebView, which has no automation protocol, so the agent cannot control a preview inside the app. On Linux it is WebKitGTK, which is slower and has more defects.
- **Tauri 2 with a separate Chrome.** This works on all systems, but the preview is not inside the app, or it shows as streamed frames.
- **Tauri 3 with its Chromium (CEF) runtime.** This runtime has the DevTools Protocol, but in November 2026 it is alpha: the APIs can change, and Windows runs without a sandbox.
- **Electrobun.** It can include Chromium, but the framework is young.

## Consequences

The app download is larger and the app uses more memory than a Tauri app. When the Tauri CEF runtime is stable, examine this decision again.
