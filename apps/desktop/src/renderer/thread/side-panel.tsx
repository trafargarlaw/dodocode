// The panel beside a thread's conversation, in tabs: what the work changed, and the files of the
// repository it's in. The thread's header opens and closes it. Its edge drags to make it wider or
// narrower, and it can take the whole page, the conversation hidden behind it. On a narrow window
// it lies over the conversation instead, until closed.

import {
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type PointerEvent,
  type RefObject,
} from "react";
import { useAppHotkeys } from "@tanstack/react-hotkeys";
import type { Project, PullRequest, Thread, WorkRepo } from "@dodocode/protocol";
import {
  ArrowDown01Icon,
  ArrowExpand01Icon,
  ArrowShrink01Icon,
  Cancel01Icon,
  Folder01Icon,
  GitBranchIcon,
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@dodocode/ui/components/tabs";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";
import { ChangesView } from "./changes";
import { FilesView } from "./files-view";
import { useWorkChanges } from "./work-changes";
import { branchLabel } from "./workspace";

/** A store of one value that components read, and that saves itself where `save` says. */
function store<T>(initial: T, save?: (value: T) => void) {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: T) {
      if (next === value) return;
      value = next;
      save?.(next);
      for (const listener of Array.from(listeners)) listener();
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function read<T>(load: () => T, fallback: T): T {
  try {
    return load();
  } catch {
    return fallback;
  }
}

function keep(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // It still works; it just won't be kept.
  }
}

// Open or closed, and how wide

const OPEN_KEY = "dodocode.sidePanel";
const WIDTH_KEY = "dodocode.sidePanelWidth";
/** Narrower than this, the panel lies over the conversation rather than squeeze it. */
const BESIDE_MIN = 880;
/** The narrowest the panel gets. */
const PANEL_MIN = 320;
/** The room the conversation keeps beside the panel. */
const CONVERSATION_MIN = 360;
/** How far an arrow key moves the panel's edge. */
const STEP = 32;

/** Whether the panel stays open beside the conversation, for every thread, between launches. */
const keptOpen = store(
  read(() => localStorage.getItem(OPEN_KEY) === "open", false),
  (open) => keep(OPEN_KEY, open ? "open" : "closed"),
);

/** How wide the person made the panel, kept between launches. Unset, it takes its usual width. */
const keptWidth = store<number | undefined>(
  read(() => {
    const width = Number(localStorage.getItem(WIDTH_KEY));
    return width >= PANEL_MIN ? width : undefined;
  }, undefined),
  (width) => keep(WIDTH_KEY, width === undefined ? undefined : String(Math.round(width))),
);

/** Whether the open panel takes the whole page. Only while the app runs. */
const fullPage = store(false);

/**
 * Whether the panel shows, and whether beside the conversation or over it. Wide enough, it stays
 * open or closed for every thread. Too narrow, it opens over the conversation only when asked,
 * and closes again as the thread is left. Give `measure` the element it shares the width of with
 * the conversation.
 */
export function useSidePanel() {
  const kept = useSyncExternalStore(keptOpen.subscribe, keptOpen.get);
  const full = useSyncExternalStore(fullPage.subscribe, fullPage.get);
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

  const open = beside ? kept : peeking;
  // Steady, so the panel, drawn only when what it shows changes, isn't drawn for these.
  const show = useCallback(() => (beside ? keptOpen.set(true) : setPeeking(true)), [beside]);
  const close = useCallback(() => {
    // It opens again beside the conversation, not over the whole page.
    fullPage.set(false);
    if (beside) keptOpen.set(false);
    else setPeeking(false);
  }, [beside]);
  const toggle = useCallback(() => (open ? close() : show()), [open, close, show]);
  // Opens it, if closed, to take the whole page.
  const toggleFull = useCallback(() => {
    if (!open) show();
    fullPage.set(!open || !fullPage.get());
  }, [open, show]);

  return {
    /** Takes the element the panel shares its width with. */
    measure: setElement,
    open,
    /** Lying over the conversation, rather than beside it. */
    over: !beside,
    /** Taking the whole page, while open. */
    full: open && full,
    toggle,
    show,
    close,
    toggleFull,
  };
}

/** The panel's width, as the person left it, kept to what the room allows. */
function widthStyle(width: number, over: boolean): string {
  return over
    ? `min(${width}px, 100%)`
    : `max(${PANEL_MIN}px, min(${width}px, calc(100% - ${CONVERSATION_MIN}px)))`;
}

/** Sets the panel's width on the page itself, while a drag moves it faster than React draws. */
function setWidth(panel: HTMLElement | null, width: string): void {
  if (panel) panel.style.width = width;
}

// The panel

type Tab = "changes" | "files";

/** The tab last looked at, which a thread's panel opens on. */
let lastTab: Tab = "changes";

export const SidePanel = memo(function SidePanel({
  thread,
  project,
  over,
  full,
  onClose,
  onToggleFull,
}: {
  thread: Thread;
  project: Project;
  /** Lying over the conversation: it then closes with Escape. */
  over: boolean;
  /** Taking the whole page: Escape gives the conversation its room back. */
  full: boolean;
  onClose: () => void;
  onToggleFull: () => void;
}) {
  const hotkeys = useAppHotkeys();
  const width = useSyncExternalStore(keptWidth.subscribe, keptWidth.get);
  const [tab, setTab] = useState<Tab>(lastTab);
  const repos = thread.repos ?? [];
  // Which of its repositories shows: one of the others it reached, or unset for its own.
  const [picked, setPicked] = useState<string>();
  const repo = repos.find((entry) => entry.root === picked) ?? repos[0];
  const other = repo && repo !== repos[0] ? repo.root : undefined;
  const work = useWorkChanges(thread.id, thread.activityAt, other);
  // A file the Files tab asked the Changes tab to show, each ask apart.
  const [reveal, setReveal] = useState<{ path: string; at: number }>();

  // Lying over the conversation, or over the whole page, it takes the focus, so Escape works,
  // and nothing is left focused behind it. It gives the focus back as it leaves.
  const aside = useRef<HTMLElement>(null);
  const covers = over || full;
  useLayoutEffect(() => {
    if (!covers) return;
    const before = document.activeElement;
    aside.current?.focus();
    return () => {
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, [covers]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    // A menu opened from the panel closes on its own Escape, and the panel stays.
    if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (full) onToggleFull();
    else if (over) onClose();
  }

  const pickTab = (next: Tab) => {
    lastTab = next;
    setTab(next);
  };
  const fullLabel = full ? "Show the conversation again" : "Take the whole page";

  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape closes it while it lies over the conversation
    <aside
      ref={aside}
      tabIndex={-1}
      aria-label="Beside the conversation"
      onKeyDown={onKeyDown}
      style={!full && width !== undefined ? { width: widthStyle(width, over) } : undefined}
      className={cn(
        "flex shrink-0 flex-col bg-background outline-none",
        full
          ? "absolute inset-0 z-20"
          : over
            ? "absolute inset-y-0 right-0 z-20 w-[min(100%,40rem)] border-l shadow-[0_0_0_1px_rgb(0_0_0/0.04),-16px_0_40px_-20px_rgb(0_0_0/0.3)]"
            : "relative w-[clamp(22rem,46%,52rem)] border-l",
      )}
    >
      {!full && <ResizeEdge aside={aside} over={over} width={width} />}
      <Tabs
        value={tab}
        onValueChange={(next) => pickTab(next as Tab)}
        className="min-h-0 flex-1 gap-0"
      >
        <div className="flex h-10 shrink-0 items-center gap-1 border-b pr-2 pl-3">
          <TabsList variant="line" className="h-full p-0">
            <TabsTrigger value="changes" className="px-2 text-[13px]">
              Changes
            </TabsTrigger>
            <TabsTrigger value="files" className="px-2 text-[13px]">
              Files
            </TabsTrigger>
          </TabsList>
          <Tip label={fullLabel} hotkey={hotkeys["panel.full"]}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={fullLabel}
              aria-pressed={full}
              className="ml-auto text-muted-foreground"
              onClick={onToggleFull}
            >
              <HugeiconsIcon icon={full ? ArrowShrink01Icon : ArrowExpand01Icon} strokeWidth={2} />
            </Button>
          </Tip>
          <Tip label="Hide the panel" hotkey={hotkeys["panel.toggle"]}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Hide the panel"
              className="text-muted-foreground"
              onClick={onClose}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </Tip>
        </div>
        <RepoBar
          thread={thread}
          project={project}
          repos={repos}
          repo={repo}
          onPick={(root) => {
            setPicked(root);
            setReveal(undefined);
          }}
        />
        <TabsContent value="changes" className="flex min-h-0 flex-col">
          <ChangesView
            thread={thread}
            project={project}
            work={work}
            repo={repo}
            inOwn={!other}
            reveal={reveal}
          />
        </TabsContent>
        <TabsContent value="files" className="flex min-h-0 flex-col">
          <FilesView
            thread={thread}
            repo={other}
            changes={work.changes}
            onOpenChange={(path) => {
              setReveal({ path, at: Date.now() });
              pickTab("changes");
            }}
          />
        </TabsContent>
      </Tabs>
    </aside>
  );
});

/**
 * The panel's left edge, which drags to make it wider or narrower, and steps with the arrow keys.
 * A double click gives it its usual width back. While it drags, only the panel's own width
 * changes; the width is kept as it's let go.
 */
function ResizeEdge({
  aside,
  over,
  width,
}: {
  aside: RefObject<HTMLElement | null>;
  over: boolean;
  width: number | undefined;
}) {
  const drag = useRef<{ x: number; from: number; room: number; to: number }>(undefined);

  /** How wide the panel can get, beside the room the conversation keeps. */
  function room(): number {
    const whole = aside.current?.parentElement?.getBoundingClientRect().width ?? Infinity;
    return Math.max(PANEL_MIN, over ? whole : whole - CONVERSATION_MIN);
  }
  const fit = (next: number, most: number) => Math.round(Math.max(PANEL_MIN, Math.min(next, most)));
  const now = () => aside.current?.getBoundingClientRect().width ?? width ?? PANEL_MIN;

  function onPointerDown(event: PointerEvent<HTMLHRElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const from = now();
    drag.current = { x: event.clientX, from, room: room(), to: from };
    document.documentElement.classList.add("cursor-col-resize", "select-none");
  }

  function onPointerMove(event: PointerEvent<HTMLHRElement>) {
    const held = drag.current;
    if (!held) return;
    held.to = fit(held.from + held.x - event.clientX, held.room);
    setWidth(aside.current, `${held.to}px`);
  }

  function onRelease() {
    const held = drag.current;
    if (!held) return;
    drag.current = undefined;
    document.documentElement.classList.remove("cursor-col-resize", "select-none");
    // What React draws may not change, so the edge puts the kept width's style back itself.
    setWidth(aside.current, widthStyle(held.to, over));
    keptWidth.set(held.to);
  }

  function onKeyDown(event: KeyboardEvent<HTMLHRElement>) {
    const step = { ArrowLeft: STEP, ArrowRight: -STEP }[event.key];
    if (step === undefined && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    const most = room();
    const next =
      event.key === "Home" ? PANEL_MIN : event.key === "End" ? most : now() + (step ?? 0);
    keptWidth.set(fit(next, most));
  }

  return (
    // A separator that moves is a control: it takes the focus, and the arrow keys.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- a separator that moves is a control
    <hr
      aria-orientation="vertical"
      aria-label="Resize the panel"
      aria-valuemin={PANEL_MIN}
      aria-valuenow={Math.round(width ?? now())}
      // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a separator that moves takes the focus
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onRelease}
      onPointerCancel={onRelease}
      onLostPointerCapture={onRelease}
      onDoubleClick={() => keptWidth.set(undefined)}
      onKeyDown={onKeyDown}
      // The line it draws shows as it's pointed at, held, or has the focus.
      className="absolute inset-y-0 -left-1.5 z-30 m-0 h-auto w-3 cursor-col-resize touch-none border-0 outline-none before:absolute before:inset-y-0 before:left-1/2 before:w-0.5 before:-translate-x-1/2 before:bg-transparent before:transition-colors before:delay-75 hover:before:bg-ring focus-visible:before:bg-ring active:before:bg-ring"
    />
  );
}

/** A folder's own name, from its full path. */
function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || path
  );
}

/**
 * The repository the panel shows, its branch, and its pull request. When the work reached more
 * than one, a picker switches between them.
 */
function RepoBar({
  thread,
  project,
  repos,
  repo,
  onPick,
}: {
  thread: Thread;
  project: Project;
  repos: readonly WorkRepo[];
  repo: WorkRepo | undefined;
  /** Picks a repository by its top folder, or unset for the one it works in. */
  onPick: (root: string | undefined) => void;
}) {
  // Before the server has read its repositories, the branch is the one the thread knows.
  const branch = repo ? (repo.branch ?? "Detached HEAD") : branchLabel(thread, project);
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b px-2 text-[12.5px]">
      {repo && repos.length > 1 ? (
        <DropdownMenu>
          <Tip label={`Its work is in ${repos.length} repositories. Pick one to see`}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 min-w-0 gap-1.5 px-1.5 text-[12.5px] font-medium"
                />
              }
            >
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} />
              <span className="truncate">{folderName(repo.root)}</span>
              <span className="text-muted-foreground tabular-nums">
                {repos.indexOf(repo) + 1}/{repos.length}
              </span>
              <HugeiconsIcon
                icon={ArrowDown01Icon}
                strokeWidth={2}
                className="size-3.5 text-muted-foreground"
              />
            </DropdownMenuTrigger>
          </Tip>
          <DropdownMenuContent align="start" className="max-w-96 min-w-64">
            <DropdownMenuRadioGroup
              value={repo.root}
              onValueChange={(root: string) => onPick(root === repos[0]?.root ? undefined : root)}
            >
              {repos.map((entry) => (
                <DropdownMenuRadioItem key={entry.root} value={entry.root}>
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{folderName(entry.root)}</span>
                    <span className="truncate font-mono text-[11px] text-muted-foreground">
                      {entry.branch ?? "Detached HEAD"}
                      {entry.pr && ` · #${entry.pr.number}`}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        repo && (
          <Tip label={repo.root}>
            <span className="flex min-w-0 items-center gap-1.5 px-1.5 font-medium">
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} className="size-4 shrink-0" />
              <span className="truncate">{folderName(repo.root)}</span>
            </span>
          </Tip>
        )
      )}
      <Tip label={`On ${branch}`}>
        <span className="flex min-w-0 items-center gap-1.5 px-1.5 text-muted-foreground">
          <HugeiconsIcon icon={GitBranchIcon} strokeWidth={1.8} className="size-4 shrink-0" />
          <span className="truncate font-mono text-[11.5px]">{branch}</span>
        </span>
      </Tip>
      {repo?.pr && <PullRequestLink pr={repo.pr} />}
    </div>
  );
}

const PR_LOOK: Record<
  PullRequest["state"] | "draft",
  { icon: typeof GitPullRequestIcon; label: string; className: string }
> = {
  open: {
    icon: GitPullRequestIcon,
    label: "Open",
    className: "text-emerald-700 dark:text-emerald-400",
  },
  draft: { icon: GitPullRequestDraftIcon, label: "Draft", className: "text-muted-foreground" },
  merged: {
    icon: GitMergeIcon,
    label: "Merged",
    className: "text-violet-700 dark:text-violet-400",
  },
  closed: {
    icon: GitPullRequestClosedIcon,
    label: "Closed",
    className: "text-red-700 dark:text-red-400",
  },
};

/** How a pull request shows, by where it stands: open, a draft, merged or closed. */
export function prLook(pr: PullRequest): (typeof PR_LOOK)[keyof typeof PR_LOOK] {
  return PR_LOOK[pr.state === "open" && pr.draft ? "draft" : pr.state];
}

/** A branch's pull request, which opens on GitHub. */
function PullRequestLink({ pr }: { pr: PullRequest }) {
  const look = prLook(pr);
  return (
    <Tip label={`${pr.title}. Open on GitHub`}>
      <a
        href={pr.url}
        target="_blank"
        rel="noreferrer"
        className={cn(
          "ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring",
          look.className,
        )}
      >
        <HugeiconsIcon icon={look.icon} strokeWidth={1.8} className="size-4" />
        <span className="tabular-nums">#{pr.number}</span>
        <span className="text-[11.5px]">{look.label}</span>
      </a>
    </Tip>
  );
}
