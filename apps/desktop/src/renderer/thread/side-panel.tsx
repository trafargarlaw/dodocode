// The panel beside a thread's conversation, in tabs: for now what the work changed. The thread's
// header opens and closes it. On a narrow window it lies over the conversation instead, until
// closed.

import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { useAppHotkeys } from "@tanstack/react-hotkeys";
import type { Project, Thread } from "@dodocode/protocol";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@dodocode/ui/components/tabs";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";
import { ChangesView } from "./changes";

// Open or closed

const OPEN_KEY = "dodocode.sidePanel";
/** Narrower than this, the panel lies over the conversation rather than squeeze it. */
const BESIDE_MIN = 880;

function loadKeptOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) === "open";
  } catch {
    return false;
  }
}

/** Whether the panel stays open beside the conversation, for every thread, between launches. */
let keptOpen = loadKeptOpen();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setKeptOpen(open: boolean): void {
  keptOpen = open;
  try {
    localStorage.setItem(OPEN_KEY, open ? "open" : "closed");
  } catch {
    // It still opens and closes; it just won't be kept.
  }
  for (const listener of Array.from(listeners)) listener();
}

/**
 * Whether the panel shows, and whether beside the conversation or over it. Wide enough, it stays
 * open or closed for every thread. Too narrow, it opens over the conversation only when asked,
 * and closes again as the thread is left. Give `measure` the element it shares the width of with
 * the conversation.
 */
export function useSidePanel() {
  const kept = useSyncExternalStore(subscribe, () => keptOpen);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [beside, setBeside] = useState(true);
  const [peeking, setPeeking] = useState(false);

  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const wide = element.getBoundingClientRect().width >= BESIDE_MIN;
      setBeside(wide);
      // A panel opened over a narrow window doesn't come back over it after it was wide.
      if (wide) setPeeking(false);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);

  // Steady, so the panel, drawn only when what it shows changes, isn't drawn for these.
  const toggle = useCallback(
    () => (beside ? setKeptOpen(!keptOpen) : setPeeking((open) => !open)),
    [beside],
  );
  const show = useCallback(() => (beside ? setKeptOpen(true) : setPeeking(true)), [beside]);
  const close = useCallback(() => (beside ? setKeptOpen(false) : setPeeking(false)), [beside]);

  return {
    /** Takes the element the panel shares its width with. */
    measure: setElement,
    open: beside ? kept : peeking,
    /** Lying over the conversation, rather than beside it. */
    over: !beside,
    toggle,
    show,
    close,
  };
}

// The panel

export const SidePanel = memo(function SidePanel({
  thread,
  project,
  over,
  onClose,
}: {
  thread: Thread;
  project: Project;
  /** Lying over the conversation: it then closes with Escape. */
  over: boolean;
  onClose: () => void;
}) {
  const hotkeys = useAppHotkeys();

  // Lying over the conversation, it takes the focus, so Escape closes it. It gives the focus back
  // as it closes.
  const aside = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!over) return;
    const before = document.activeElement;
    aside.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [over]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // A menu opened from the panel closes on its own Escape, and the panel stays.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (over && event.key === "Escape") onClose();
  }

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes it while it lies over the conversation
    <aside
      ref={aside}
      tabIndex={-1}
      aria-label="Beside the conversation"
      onKeyDown={onKeyDown}
      className={cn(
        "flex w-[clamp(22rem,46%,52rem)] shrink-0 flex-col border-l bg-background outline-none",
        over &&
          "absolute inset-y-0 right-0 z-20 w-[min(100%,40rem)] shadow-[0_0_0_1px_rgb(0_0_0/0.04),-16px_0_40px_-20px_rgb(0_0_0/0.3)]",
      )}
    >
      <Tabs defaultValue="changes" className="min-h-0 flex-1 gap-0">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-3">
          <TabsList variant="line" className="h-full p-0">
            <TabsTrigger value="changes" className="px-2 text-[13px]">
              Changes
            </TabsTrigger>
          </TabsList>
          <Tip label="Hide the panel" hotkey={hotkeys["panel.toggle"]}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide the panel"
              className="ml-auto text-muted-foreground"
              onClick={onClose}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </Tip>
        </div>
        <TabsContent value="changes" className="flex min-h-0 flex-col">
          <ChangesView thread={thread} project={project} />
        </TabsContent>
      </Tabs>
    </aside>
  );
});
