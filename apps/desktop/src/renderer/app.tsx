import { useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import {
  HotkeysProvider,
  useAppHotkeys,
  useFormatForDisplay,
  useHotkey,
  type AppHotkey,
} from "@tanstack/react-hotkeys";
import type { PanelImperativeHandle } from "react-resizable-panels";
import {
  Add01Icon,
  KeyboardIcon,
  PaintBoardIcon,
  PencilEdit02Icon,
  Search01Icon,
  SidebarLeftIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@dodocode/ui/components/popover";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@dodocode/ui/components/resizable";
import { ThemePicker, setAppearance, stepThemePreset } from "@dodocode/ui/components/theme-picker";
import { useTheme } from "@dodocode/ui/hooks/use-theme";
import { cn } from "@dodocode/ui/lib/utils";
import { HeldKeys, Keys, Tip, WALLPAPER_KEYS } from "./keys";
import { ShortcutsDialog } from "./shortcuts-dialog";
import { loadSidebar, saveSidebar, SIDEBAR } from "./sidebar-width";

const isMac = window.dodocode.platform === "darwin";

export function App() {
  const hotkeys = useAppHotkeys();
  const { theme } = useTheme();
  const [themeOpen, setThemeOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const search = useRef<HTMLButtonElement>(null);
  const newThread = useRef<HTMLButtonElement>(null);
  const sidebar = useSidebar();

  useHotkey(hotkeys["sidebar.toggle"], sidebar.toggle);
  useHotkey(hotkeys["theme.open"], () => setThemeOpen(true));
  useHotkey(hotkeys["shortcuts.open"], () => setShortcutsOpen(true));
  useHotkey(hotkeys["appearance.toggle"], () =>
    setAppearance(theme.scheme === "dark" ? "light" : "dark"),
  );
  // Search and threads are not built yet: their keys take you to where they will start.
  useHotkey(hotkeys["search.open"], () => search.current?.focus());
  useHotkey(hotkeys["thread.new"], () => newThread.current?.focus());

  return (
    <div className="grid h-screen grid-rows-[40px_minmax(0,1fr)] bg-wallpaper text-[13px] text-sidebar-foreground">
      <TitleBar
        sidebarOpen={!sidebar.collapsed}
        onToggleSidebar={sidebar.toggle}
        themeOpen={themeOpen}
        onThemeOpenChange={setThemeOpen}
        search={search}
      />
      <ResizablePanelGroup
        orientation="horizontal"
        className={cn("min-h-0 pr-2 pb-2", sidebar.collapsed && "pl-2")}
      >
        <ResizablePanel
          id="sidebar"
          panelRef={sidebar.panel}
          defaultSize={sidebar.initial.collapsed ? 0 : sidebar.initial.width}
          minSize={SIDEBAR.min}
          maxSize={SIDEBAR.max}
          collapsible
          collapsedSize={0}
          groupResizeBehavior="preserve-pixel-size"
          onResize={sidebar.onResize}
        >
          <Sidebar />
        </ResizablePanel>
        <ResizableHandle
          aria-label="Resize the sidebar"
          disabled={sidebar.collapsed}
          // The library moves it 5% of the window per arrow press; a fixed step is finer. Capture
          // runs before the library's own listener, which skips a key already handled.
          onKeyDownCapture={(event) => {
            const by = NUDGE[event.key];
            if (by === undefined) return;
            event.preventDefault();
            sidebar.nudge(by);
          }}
          className="w-0 bg-transparent before:absolute before:inset-y-3 before:right-1 before:w-0.5 before:rounded-full before:transition-colors after:right-0 after:left-auto after:w-2.5 after:translate-x-0 focus-visible:ring-0 data-[separator=active]:before:bg-sidebar-ring data-[separator=focus]:before:bg-sidebar-ring data-[separator=hover]:before:bg-sidebar-border"
        />
        <ResizablePanel id="sheet" minSize={360}>
          <Sheet newThread={newThread} onOpenShortcuts={() => setShortcutsOpen(true)} />
        </ResizablePanel>
      </ResizablePanelGroup>
      <ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
    </div>
  );
}

/** How far each arrow key moves the sidebar's edge. */
const NUDGE: Partial<Record<string, number>> = {
  ArrowLeft: -SIDEBAR.step,
  ArrowRight: SIDEBAR.step,
};

/** The sidebar's panel, its width kept between launches, and a toggle that remembers it. */
function useSidebar() {
  const panel = useRef<PanelImperativeHandle>(null);
  const [initial] = useState(loadSidebar);
  const width = useRef(initial.width);
  const [collapsed, setCollapsed] = useState(initial.collapsed);
  const saving = useRef<number>(undefined);

  return {
    panel,
    initial,
    collapsed,
    // The panel reports its size here once the page has laid it out, which the group's
    // `onLayoutChanged` runs too early to see. A drag reports every move, so save once it rests.
    onResize: ({ inPixels }: { inPixels: number }) => {
      const isCollapsed = inPixels < 1;
      setCollapsed(isCollapsed);
      if (inPixels >= SIDEBAR.min) width.current = inPixels;
      window.clearTimeout(saving.current);
      saving.current = window.setTimeout(
        () => saveSidebar({ width: width.current, collapsed: isCollapsed }),
        200,
      );
    },
    toggle: () => {
      const handle = panel.current;
      if (!handle) return;
      // Reopen at the width it had, which `expand` can't know after a launch that starts closed.
      if (handle.isCollapsed()) handle.resize(width.current);
      else handle.collapse();
    },
    nudge: (by: number) => {
      const handle = panel.current;
      if (!handle || handle.isCollapsed()) return;
      const to = handle.getSize().inPixels + by;
      handle.resize(Math.min(SIDEBAR.max, Math.max(SIDEBAR.min, to)));
    },
  };
}

// The window's own title bar: drag it to move the window. The window buttons sit over its right
// end on Windows and Linux, and the traffic lights over its left end on macOS.
function TitleBar({
  sidebarOpen,
  onToggleSidebar,
  themeOpen,
  onThemeOpenChange,
  search,
}: {
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  themeOpen: boolean;
  onThemeOpenChange: (open: boolean) => void;
  search: RefObject<HTMLButtonElement | null>;
}) {
  const hotkeys = useAppHotkeys();
  const sidebarLabel = sidebarOpen ? "Hide the sidebar" : "Show the sidebar";

  return (
    <header className="grid grid-cols-[1fr_auto_1fr] items-center [-webkit-app-region:drag]">
      <div className={cn("flex items-center gap-2.5", isMac ? "pl-20" : "pl-3.5")}>
        <span
          aria-hidden
          className="grid size-5 place-items-center rounded-md bg-primary text-xs font-extrabold text-primary-foreground"
        >
          d
        </span>
        <span className="font-semibold tracking-tight">dodocode</span>
        <div className="ml-1 flex items-center gap-0.5">
          <Tip label={sidebarLabel} hotkey={hotkeys["sidebar.toggle"]}>
            <TitleButton
              aria-label={sidebarLabel}
              aria-expanded={sidebarOpen}
              onClick={onToggleSidebar}
            >
              <HugeiconsIcon icon={SidebarLeftIcon} strokeWidth={1.8} />
              <HeldKeys
                hotkey={hotkeys["sidebar.toggle"]}
                className="top-full left-1/2 mt-1 -translate-x-1/2"
              />
            </TitleButton>
          </Tip>
          <Popover open={themeOpen} onOpenChange={onThemeOpenChange}>
            <Tip label="Theme" hotkey={hotkeys["theme.open"]}>
              <PopoverTrigger render={<TitleButton aria-label="Theme" />}>
                <HugeiconsIcon icon={PaintBoardIcon} strokeWidth={1.8} />
              </PopoverTrigger>
            </Tip>
            <PopoverContent
              side="bottom"
              align="start"
              sideOffset={8}
              className="w-75 rounded-2xl p-3"
            >
              {/* While the theme is open, its keys are the only ones that run. */}
              <HotkeysProvider scope="theme" exclusive>
                <ThemePanel onClose={() => onThemeOpenChange(false)} />
              </HotkeysProvider>
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <button
        ref={search}
        type="button"
        className="relative flex h-7 w-[min(400px,40vw)] items-center gap-2 rounded-lg border border-sidebar-border bg-sidebar-accent pr-1 pl-2.5 text-[12.5px] text-sidebar-muted-foreground transition-colors outline-none [-webkit-app-region:no-drag] hover:bg-sidebar-selected focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <HugeiconsIcon icon={Search01Icon} strokeWidth={1.8} className="size-3.75 shrink-0" />
        <span className="flex-1 truncate text-left">Search threads, files and commands</span>
        {hotkeys["search.open"].hotkey && (
          <Keys hotkey={hotkeys["search.open"].hotkey} className={WALLPAPER_KEYS} />
        )}
      </button>
    </header>
  );
}

function TitleButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "relative text-sidebar-muted-foreground [-webkit-app-region:no-drag] hover:bg-sidebar-accent hover:text-sidebar-foreground aria-expanded:text-sidebar-foreground data-popup-open:bg-sidebar-selected data-popup-open:text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}

function ThemePanel({ onClose }: { onClose: () => void }) {
  const hotkeys = useAppHotkeys();
  const format = useFormatForDisplay();
  const previous = hotkeys["theme.previousPreset"];
  const next = hotkeys["theme.nextPreset"];

  useHotkey(previous, () => stepThemePreset(-1));
  useHotkey(next, () => stepThemePreset(1));
  // The keys that opened the theme close it too.
  useHotkey(hotkeys["theme.open"], onClose);

  return (
    <ThemePicker
      keys={{
        previousPreset: previous.hotkey ? format(previous.hotkey) : undefined,
        nextPreset: next.hotkey ? format(next.hotkey) : undefined,
      }}
    />
  );
}

function Sidebar() {
  const hotkeys = useAppHotkeys();

  return (
    <nav aria-label="Threads" className="flex h-full min-h-0 flex-col gap-px px-2.5 pt-1.5 pb-2.5">
      <SidebarRow icon={PencilEdit02Icon} className="relative font-medium">
        <span className="flex-1">New thread</span>
        <HeldKeys hotkey={hotkeys["thread.new"]} className="right-1.5" />
      </SidebarRow>

      <div className="flex items-center justify-between pt-3.5 pr-1 pb-1 pl-2 text-[11.5px] text-sidebar-muted-foreground">
        <span>Projects</span>
        <Tip label="Add a project" side="right">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Add a project"
            className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          </Button>
        </Tip>
      </div>
      <p className="px-2 py-1.5 text-sidebar-muted-foreground">No projects yet.</p>
    </nav>
  );
}

function SidebarRow({
  icon,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { icon: typeof Add01Icon }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7.5 w-full items-center gap-2 rounded-[7px] px-2 text-left whitespace-nowrap transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
        className,
      )}
      {...props}
    >
      <HugeiconsIcon
        icon={icon}
        strokeWidth={1.8}
        className="size-3.75 shrink-0 text-sidebar-muted-foreground"
      />
      {children}
    </button>
  );
}

// The floating sheet that holds the thread.
function Sheet({
  newThread,
  onOpenShortcuts,
}: {
  newThread: RefObject<HTMLButtonElement | null>;
  onOpenShortcuts: () => void;
}) {
  const hotkeys = useAppHotkeys();

  return (
    <main className="grid h-full min-h-0 grid-rows-[minmax(0,1fr)_auto] overflow-hidden rounded-[14px] border border-black/8 bg-background text-foreground shadow-[0_1px_2px_rgb(0_0_0/0.05),0_18px_48px_-20px_rgb(0_0_0/0.28)] dark:border-white/10 dark:shadow-[0_24px_60px_-20px_rgb(0_0_0/0.6)]">
      <div className="grid place-items-center p-8">
        <div className="flex max-w-sm flex-col items-center gap-3 text-center">
          <h1 className="text-lg font-semibold tracking-tight">No thread open</h1>
          <p className="text-muted-foreground">
            Start a thread to work on a project. Your threads show in the sidebar.
          </p>
          <Button ref={newThread} className="mt-1">
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={2} data-icon="inline-start" />
            New thread
          </Button>
        </div>
      </div>
      <footer className="flex h-8.5 items-center gap-4 border-t px-4.5 text-[11.5px] text-muted-foreground">
        <Hint hotkey={hotkeys["thread.new"]}>New thread</Hint>
        <Hint hotkey={hotkeys["search.open"]}>Search</Hint>
        <button
          type="button"
          onClick={onOpenShortcuts}
          className="ml-auto inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HugeiconsIcon icon={KeyboardIcon} strokeWidth={1.8} className="size-3.5" />
          Shortcuts
          {hotkeys["shortcuts.open"].hotkey && <Keys hotkey={hotkeys["shortcuts.open"].hotkey} />}
        </button>
      </footer>
    </main>
  );
}

function Hint({ hotkey, children }: { hotkey: AppHotkey; children: ReactNode }) {
  if (!hotkey.hotkey) return null;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Keys hotkey={hotkey.hotkey} />
      {children}
    </span>
  );
}
