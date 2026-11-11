import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HotkeysProvider } from "@tanstack/react-hotkeys";
import { TooltipProvider } from "@dodocode/ui/components/tooltip";
import { startTheme } from "@dodocode/ui/hooks/use-theme";
import { App } from "./app";
import { appHotkeys, loadCustomHotkeys, saveCustomHotkeys } from "./hotkeys";
import "@dodocode/ui/globals.css";

// Apply the saved theme before the first render, so the window opens in it.
let windowTheme = "";
startTheme({
  onApply: ({ settings, theme }) => {
    const next = { appearance: settings.appearance, symbolColor: theme.text };
    // Dragging a colour applies the theme on every frame: only send the window what changed.
    const key = JSON.stringify(next);
    if (key === windowTheme) return;
    windowTheme = key;
    window.dodocode.setWindowTheme(next);
  },
});

// Read once: a new object on each render would replace the bindings people just changed.
const customHotkeys = loadCustomHotkeys();

createRoot(document.getElementById("root") as HTMLElement).render(
  <StrictMode>
    <HotkeysProvider
      appHotkeys={appHotkeys}
      customHotkeys={customHotkeys}
      onCustomHotkeysChange={saveCustomHotkeys}
    >
      <TooltipProvider delay={500}>
        <App />
      </TooltipProvider>
    </HotkeysProvider>
  </StrictMode>,
);
