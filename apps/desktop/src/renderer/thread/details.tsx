// A thread's details, in a card in the conversation's top corner, which the conversation makes
// room for, or which lies over it when the conversation has too little room: where it works and what that changed, where it stands, the
// agent's plan, and the subagents, reviews and background work it started. The header's button
// shows and hides it, and it stays until hidden, from thread to thread.

import {
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import { eq, useLiveQuery } from "@tanstack/react-db";
import {
  disputesWaiting,
  type BackgroundJob,
  type Project,
  type PullRequest,
  type Thread,
  type ThreadStatus,
  type TodoEntry,
  type WorkspaceMode,
} from "@dodocode/protocol";
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  Clock01Icon,
  CommandLineIcon,
  ComputerIcon,
  Flag01Icon,
  Folder01Icon,
  GitBranchIcon,
  GitCompareIcon,
  GitForkIcon,
  GitMergeIcon,
  InformationCircleIcon,
  InspectCodeIcon,
  StopCircleIcon,
  Tick02Icon,
  UserMultiple02Icon,
  ZapIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import { Separator } from "@dodocode/ui/components/separator";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { VisualStudioCodeLogo } from "../brand-icons";
import { Tip } from "../keys";
import { folderName } from "../palette/sessions";
import { openFolder, openThreadInEditor, threads } from "../server/app-data";
import { stopJob } from "../server/thread-data";
import { GROUP_LABEL } from "../task-list";
import { Attention, MoveItems, StatusGlyph } from "../task-ui";
import { ago, duration, useNow } from "../time";
import { openRelated } from "../view";
import { useChangeCount } from "./change-count";
import { TodoList } from "./steps";
import { prLook } from "./side-panel";
import {
  branchLabel,
  changesToShow,
  Counts,
  ownRepo,
  workPlace,
  type WorkPlace,
} from "./workspace";

// Shown or hidden

const SHOWN_KEY = "dodocode.details";

/** Shown unless hidden: a new person sees where the work is and what it changed at once. */
function loadShown(): boolean {
  try {
    return localStorage.getItem(SHOWN_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** Whether the details show, for every thread, between launches. */
let shown = loadShown();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function setShown(next: boolean): void {
  shown = next;
  try {
    localStorage.setItem(SHOWN_KEY, next ? "shown" : "hidden");
  } catch {
    // They still show and hide; it just won't be kept.
  }
  for (const listener of Array.from(listeners)) listener();
}

function useDetailsShown(): boolean {
  return useSyncExternalStore(subscribe, () => shown);
}

/** The header's button that shows and hides the details, and, while hidden, the work running. */
export function DetailsButton({ jobs }: { jobs: BackgroundJob[] }) {
  const hotkeys = useAppHotkeys();
  const open = useDetailsShown();
  useHotkey(hotkeys["details.toggle"], () => setShown(!shown));
  const label = open ? "Hide the details" : "Show the details";
  const running = jobs.filter((job) => job.status === "running").length;
  return (
    <>
      {!open && running > 0 && (
        <Tip label="Background work: show the details">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-muted-foreground"
            onClick={() => setShown(true)}
          >
            <Spinner className="size-3.5" />
            {running} running
          </Button>
        </Tip>
      )}
      <Tip label={label} hotkey={hotkeys["details.toggle"]}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-expanded={open}
          className={cn("text-muted-foreground", open && "bg-muted text-foreground")}
          onClick={() => setShown(!open)}
        >
          <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={1.8} />
        </Button>
      </Tip>
    </>
  );
}

function hideOnEscape(event: KeyboardEvent<HTMLElement>) {
  // A menu opened from the card closes on its own Escape, and the card stays.
  if (!(event.target instanceof Node) || !event.currentTarget.contains(event.target)) return;
  if (event.key === "Escape") setShown(false);
}

interface DetailsProps {
  thread: Thread;
  project: Project | undefined;
  /** The agent's plan, as it last wrote it. */
  todos: TodoEntry[] | undefined;
  jobs: BackgroundJob[];
  /** Where it will work, while that can still change. */
  mode: WorkspaceMode;
  /** Shows what the work changed, beside the conversation. */
  onShowChanges: () => void;
}

/** The card's width. */
const CARD_WIDTH = 320;
/** The card's distance from the right edge. */
const CARD_EDGE = 12;
/** The width the conversation keeps beside the card; narrower, the card lies over it. */
const CONVERSATION_MIN = 560;

/**
 * The room the conversation leaves on its right for the card, in pixels: none while the card is
 * hidden, or when the conversation would be left too narrow and the card lies over it instead.
 * Give it the element that holds the conversation and the card.
 */
export function useDetailsRoom(element: HTMLElement | null): number {
  const shownNow = useDetailsShown();
  const [wide, setWide] = useState(false);
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () =>
      setWide(element.getBoundingClientRect().width >= CARD_WIDTH + CARD_EDGE + CONVERSATION_MIN);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return shownNow && wide ? CARD_WIDTH + CARD_EDGE : 0;
}

/**
 * The details, while they're shown, in a card in the top corner of what holds them. The
 * conversation makes room for it with useDetailsRoom while it can, and it lies over the
 * conversation when it can't. Escape from inside hides them.
 */
export function DetailsCard({ className, ...props }: DetailsProps & { className?: string }) {
  if (!useDetailsShown()) return null;
  return (
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- Escape hides it
    <section
      aria-label="Details"
      onKeyDown={hideOnEscape}
      style={{ right: CARD_EDGE, width: `min(${CARD_WIDTH}px, calc(100% - ${2 * CARD_EDGE}px))` }}
      className={cn(
        "absolute top-2 z-10 flex max-h-[calc(100%-1rem)] origin-top-right animate-in flex-col overflow-y-auto rounded-lg bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100 fade-in-0 zoom-in-95",
        className,
      )}
    >
      <Details {...props} />
    </section>
  );
}

function Details({ thread, project, todos, jobs, mode, onShowChanges }: DetailsProps) {
  const { data: children = [] } = useLiveQuery({
    queryKey: ["children", thread.id],
    query: (q) =>
      q
        .from({ row: threads })
        .where(({ row }) => eq(row.parentId, thread.id))
        .orderBy(({ row }) => row.createdAt, "desc"),
  });
  const subagents = children.filter((child) => child.kind === "subagent").toSorted(byActive);
  const reviews = children.filter((child) => child.kind === "review");
  const done = todos?.filter((todo) => todo.status === "completed").length ?? 0;

  return (
    <>
      {thread.kind === "subagent" ? (
        <SubagentRows thread={thread} />
      ) : thread.kind === "review" ? (
        <ReviewRows thread={thread} />
      ) : (
        <>
          {project && (
            <WorkspaceRows
              thread={thread}
              project={project}
              mode={mode}
              onShowChanges={onShowChanges}
            />
          )}
          <StatusRow thread={thread} />
        </>
      )}
      {todos && (
        <Part title="Plan" count={`${done} of ${todos.length}`}>
          <div className="px-2 pt-0.5 pb-1.5">
            <TodoList todos={todos} />
          </div>
        </Part>
      )}
      {subagents.length > 0 && (
        <Part title="Subagents" count={subagents.length}>
          {subagents.map((child) => (
            <ChildRow
              key={child.id}
              thread={child}
              idle={<HugeiconsIcon icon={Tick02Icon} strokeWidth={2} aria-label="Done" />}
            >
              {child.title}
            </ChildRow>
          ))}
        </Part>
      )}
      {reviews.length > 0 && <ReviewsPart reviews={reviews} />}
      {jobs.length > 0 && <BackgroundPart threadId={thread.id} jobs={jobs} />}
    </>
  );
}

/** What runs or waits first, then the newest. */
function byActive(a: Thread, b: Thread): number {
  return Number(active(b.status)) - Number(active(a.status)) || b.createdAt - a.createdAt;
}

function active(status: ThreadStatus): boolean {
  return status === "running" || status === "waiting";
}

// Rows

const ROW =
  "flex min-h-8 w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1 text-left text-[13px]";
/** A row that does something as it's clicked. */
const ACTION = cn(
  ROW,
  "outline-none transition-colors hover:bg-muted focus-visible:bg-muted data-popup-open:bg-muted",
);

function RowIcon({ icon }: { icon: typeof GitForkIcon }) {
  return (
    <HugeiconsIcon
      icon={icon}
      strokeWidth={1.8}
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
}

/** A fact with its name, which can't be changed from here. */
function Fact({
  icon,
  label,
  children,
}: {
  icon: typeof GitForkIcon;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={ROW}>
      <RowIcon icon={icon} />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </div>
  );
}

/** A part below a line, under a plain heading. A count, when given, sits at the heading's end. */
function Part({
  title,
  count,
  children,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="flex flex-col">
      <Separator className="my-1" />
      <h2 className="flex items-center gap-2 px-2 pt-1 pb-1 text-[12px] font-medium text-muted-foreground">
        {title}
        {count !== undefined && <span className="ml-auto font-normal tabular-nums">{count}</span>}
      </h2>
      {children}
    </section>
  );
}

// Where it works

/** The system's file manager, by the name people know it. */
function fileManager(): string {
  const platform = window.dodocode.platform;
  if (platform === "darwin") return "Finder";
  if (platform === "win32") return "File Explorer";
  return "the file manager";
}

/** Where a thread works, as its details name it, and the folder that is, when there is one. */
function whereItWorks(
  place: WorkPlace | undefined,
  mode: WorkspaceMode,
  project: Project,
): { icon: typeof GitForkIcon; label: string; tip: string; folder?: string } {
  if (!place)
    return { icon: ComputerIcon, label: "Project folder", tip: project.path, folder: project.path };
  switch (place.kind) {
    case "choosing":
      return mode === "worktree"
        ? {
            icon: GitForkIcon,
            label: "New worktree",
            tip: "A separate checkout, made as the work starts. Your folder stays as it is.",
            folder: project.path,
          }
        : {
            icon: ComputerIcon,
            label: "Current checkout",
            tip: project.path,
            folder: project.path,
          };
    case "worktree":
      return {
        icon: GitForkIcon,
        label: "Worktree",
        tip: place.worktree.path,
        folder: place.worktree.path,
      };
    case "folder":
      return {
        icon: ComputerIcon,
        label: "Current checkout",
        tip: project.path,
        folder: project.path,
      };
    case "other":
      return {
        icon: GitForkIcon,
        label: "Other checkout",
        tip: `Where it worked in ${place.app}: ${place.checkout.path}`,
        folder: place.checkout.path,
      };
    case "merged":
      return {
        icon: GitMergeIcon,
        label: `Merged into ${place.worktree.base ?? "its branch"}`,
        tip: `${place.worktree.branch} was merged, and its worktree removed`,
      };
  }
}

function WorkspaceRows({
  thread,
  project,
  mode,
  onShowChanges,
}: {
  thread: Thread;
  project: Project;
  mode: WorkspaceMode;
  onShowChanges: () => void;
}) {
  const place = workPlace(thread, project);
  const where = whereItWorks(place, mode, project);
  const folder = where.folder;
  const pr = ownRepo(thread, project)?.pr;
  return (
    <>
      <div className={ROW}>
        <RowIcon icon={where.icon} />
        <Tip label={where.tip}>
          <span className="min-w-0 flex-1 truncate">{where.label}</span>
        </Tip>
        {folder && (
          <Tip label={`Show it in ${fileManager()}`}>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Show the folder"
              className="-my-1 -mr-1 text-muted-foreground"
              onClick={() => openFolder(folder)}
            >
              <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} />
            </Button>
          </Tip>
        )}
      </div>
      <button type="button" className={ACTION} onClick={() => openThreadInEditor(thread.id)}>
        <span className="flex size-4 shrink-0 items-center justify-center">
          <VisualStudioCodeLogo className="size-3.5" />
        </span>
        Open in VS Code
      </button>
      {place && (
        <>
          <Separator className="my-1" />
          <div className={ROW}>
            <RowIcon icon={GitBranchIcon} />
            <span className="min-w-0 flex-1 truncate">
              {place.kind === "choosing" ? (
                mode === "worktree" ? (
                  <>
                    New branch from{" "}
                    <BranchName>{place.branch ?? "the commit checked out"}</BranchName>
                  </>
                ) : (
                  <BranchName>{place.branch ?? "Detached HEAD"}</BranchName>
                )
              ) : (
                <BranchName>
                  {place.kind === "merged" ? place.worktree.branch : branchLabel(thread, project)}
                </BranchName>
              )}
            </span>
          </div>
          {pr && place.kind !== "merged" && <PullRequestRow pr={pr} />}
          {changesToShow(place) && (
            <ChangesRow thread={thread} against={pr?.base} onClick={onShowChanges} />
          )}
        </>
      )}
      <Separator className="my-1" />
    </>
  );
}

function BranchName({ children }: { children: ReactNode }) {
  return <span className="font-mono text-[12px]">{children}</span>;
}

/** The pull request of the branch the thread works on, which opens on GitHub. */
function PullRequestRow({ pr }: { pr: PullRequest }) {
  const look = prLook(pr);
  return (
    <Tip label="Open on GitHub">
      <a href={pr.url} target="_blank" rel="noreferrer" className={ACTION}>
        <HugeiconsIcon
          icon={look.icon}
          strokeWidth={1.8}
          className={cn("size-4", look.className)}
        />
        <span className="min-w-0 flex-1 truncate">
          <span className="tabular-nums">#{pr.number}</span>{" "}
          <span className="text-muted-foreground">{pr.title}</span>
        </span>
        <span className={cn("shrink-0 text-[12px] font-medium", look.className)}>{look.label}</span>
      </a>
    </Tip>
  );
}

/**
 * How much the work changed, read before it's asked for. It opens the whole of it. Against the
 * branch it merges into, when that's known; otherwise since the work started.
 */
function ChangesRow({
  thread,
  against,
  onClick,
}: {
  thread: Thread;
  /** The branch the pull request merges into. */
  against: string | undefined;
  onClick: () => void;
}) {
  const count = useChangeCount(thread.id, thread.activityAt) ?? thread.worktree?.changed;
  const worktree = thread.worktree;
  const base = worktree ? (worktree.base ?? "where it started") : against;
  return (
    <button type="button" className={ACTION} onClick={onClick}>
      <RowIcon icon={GitCompareIcon} />
      <span className="min-w-0 flex-1 truncate">
        Changes {base && <span className="text-muted-foreground">vs {base}</span>}
      </span>
      {!count ? (
        <Spinner className="size-3.5 text-muted-foreground" />
      ) : count.files === 0 ? (
        <span className="text-[12px] text-muted-foreground">None</span>
      ) : (
        <Counts added={count.added} removed={count.removed} />
      )}
    </button>
  );
}

// Where it stands

const STATE: Record<ThreadStatus, string> = {
  idle: "Done",
  running: "Working",
  waiting: "Waiting for you",
  error: "Stopped by an error",
};

/** Where the thread is on the board, and a menu to put it elsewhere, or to make it a task. */
function StatusRow({ thread }: { thread: Thread }) {
  const label = thread.task ? GROUP_LABEL[thread.task.status] : "Chat";
  const glyph = (
    <span className="grid size-4 shrink-0 place-items-center">
      <StatusGlyph status={thread.task?.status ?? "chats"} />
    </span>
  );
  // A chat without a project has nothing to change, so it can't be a task.
  if (!thread.task && !thread.projectId) {
    return (
      <div className={ROW}>
        {glyph}
        <span className="flex-1">Chat</span>
        <span className="text-[12px] text-muted-foreground">Without a project, not a task</span>
      </div>
    );
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<button type="button" aria-label={`Status: ${label}`} className={ACTION} />}
      >
        {glyph}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {!thread.task && <span className="text-[12px] text-muted-foreground">Make it a task</span>}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          className="size-3.5 shrink-0 text-muted-foreground"
        />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        {!thread.task && (
          <DropdownMenuGroup>
            <DropdownMenuLabel>Make it a task</DropdownMenuLabel>
          </DropdownMenuGroup>
        )}
        <MoveItems thread={thread} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SubagentRows({ thread }: { thread: Thread }) {
  return (
    <>
      <ParentRow threadId={thread.parentId} icon={UserMultiple02Icon} lead="Started by" />
      <div className={ROW}>
        <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
          <Attention thread={thread} />
        </span>
        <span className="truncate">{STATE[thread.status]}</span>
      </div>
    </>
  );
}

function ReviewRows({ thread }: { thread: Thread }) {
  const review = thread.review;
  return (
    <>
      <ParentRow threadId={thread.parentId} icon={InspectCodeIcon} lead="Reviews" />
      {review && (
        <>
          <Fact icon={GitCompareIcon} label="Against">
            <BranchName>{review.baseLabel}</BranchName>
          </Fact>
          <Fact icon={BookOpen01Icon} label="Guide">
            {review.instructions ? folderName(review.instructions) : "Built-in"}
          </Fact>
          <Fact icon={Flag01Icon} label="Found">
            {findingsSummary(thread) || "Nothing reported yet"}
          </Fact>
        </>
      )}
    </>
  );
}

/** The thread another one belongs to, which it opens. */
function ParentRow({
  threadId,
  icon,
  lead,
}: {
  threadId: string | undefined;
  icon: typeof GitForkIcon;
  lead: string;
}) {
  const { data: parent } = useLiveQuery({
    queryKey: ["thread", threadId ?? ""],
    query: (q) =>
      q
        .from({ row: threads })
        .where(({ row }) => eq(row.id, threadId ?? ""))
        .findOne(),
  });
  if (!parent) {
    return (
      <Fact icon={icon} label={lead}>
        <span className="text-muted-foreground">A thread that's gone</span>
      </Fact>
    );
  }
  return (
    <button type="button" className={ACTION} onClick={() => openRelated(parent.id)}>
      <RowIcon icon={icon} />
      <span className="shrink-0 text-muted-foreground">{lead}</span>
      <span className="min-w-0 flex-1 truncate">{parent.title}</span>
    </button>
  );
}

// What it started

/** A subagent or a review, which opens its thread. */
function ChildRow({
  thread,
  idle,
  end,
  children,
}: {
  thread: Thread;
  /** Its mark once it's done. */
  idle: ReactNode;
  /** What shows at the end, in place of how long ago it was busy. */
  end?: ReactNode;
  children: ReactNode;
}) {
  const now = useNow();
  return (
    <button type="button" className={ACTION} onClick={() => openRelated(thread.id)}>
      <span className="grid size-4 shrink-0 place-items-center text-muted-foreground [&_svg]:size-3.5">
        <Attention thread={thread} idle={idle} />
      </span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <span className="shrink-0 text-[11.5px] text-muted-foreground tabular-nums">
        {end ?? ago(thread.activityAt, now)}
      </span>
    </button>
  );
}

function ReviewsPart({ reviews }: { reviews: Thread[] }) {
  return (
    <Part title="Reviews" count={reviews.length}>
      {reviews.map((review) => {
        const waiting = review.review ? disputesWaiting(review.review).length : 0;
        return (
          <ChildRow
            key={review.id}
            thread={review}
            idle={<HugeiconsIcon icon={InspectCodeIcon} strokeWidth={1.8} aria-hidden />}
            end={
              waiting > 0 ? (
                <span className="text-amber-700 dark:text-amber-400">{waiting} to decide</span>
              ) : (
                findingsSummary(review) || undefined
              )
            }
          >
            Against {review.review?.baseLabel ?? "its base"}
          </ChildRow>
        );
      })}
    </Part>
  );
}

/** How many findings a review reported, once it has. */
function findingsSummary(review: Thread): string {
  if (!review.review?.reportedAt) return "";
  const count = review.review.findings.length;
  if (count === 0) return "Nothing found";
  return `${count} ${count === 1 ? "finding" : "findings"}`;
}

const JOB_ICON: Record<BackgroundJob["kind"], typeof ZapIcon> = {
  command: CommandLineIcon,
  subagent: UserMultiple02Icon,
  monitor: Clock01Icon,
  other: ZapIcon,
};

const JOB_STATUS: Record<BackgroundJob["status"], string> = {
  running: "Running",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

/** Work the agent left running while it went on: commands, monitors and the like. */
function BackgroundPart({ threadId, jobs }: { threadId: string; jobs: BackgroundJob[] }) {
  const running = jobs.filter((job) => job.status === "running").length;
  return (
    <Part title="Background" count={running > 0 ? `${running} running` : jobs.length}>
      <ul className="flex flex-col">
        {jobs.map((job) => (
          <li key={job.id} className="flex items-start gap-2.5 rounded-md px-2 py-1.5">
            <HugeiconsIcon
              icon={JOB_ICON[job.kind]}
              strokeWidth={1.8}
              className="mt-0.5 size-4 shrink-0 text-muted-foreground"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="truncate text-[13px]">{job.title}</span>
              <span
                className={cn(
                  "text-xs text-muted-foreground",
                  job.status === "failed" && "text-destructive",
                )}
              >
                {JOB_STATUS[job.status]}
                {job.endedAt !== undefined && ` · ${duration(job.endedAt - job.startedAt)}`}
                {job.summary && ` · ${job.summary}`}
              </span>
            </div>
            {job.status === "running" && (
              <Tip label="Stop">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Stop ${job.title}`}
                  onClick={() => stopJob(threadId, job.id)}
                >
                  <HugeiconsIcon icon={StopCircleIcon} strokeWidth={1.8} />
                </Button>
              </Tip>
            )}
          </li>
        ))}
      </ul>
    </Part>
  );
}
