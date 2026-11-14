import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
  type Ref,
  type UIEvent,
} from "react";
import { useAppHotkeys, useHotkey } from "@tanstack/react-hotkeys";
import { and, eq, useLiveQuery } from "@tanstack/react-db";
import {
  unstarted,
  type Item,
  type Project,
  type QueuedMessage,
  type Thread,
} from "@dodocode/protocol";
import {
  ArrowLeft01Icon,
  Cancel01Icon,
  Clock01Icon,
  InspectCodeIcon,
  SidebarRightIcon,
  SteeringIcon,
  Scissor01Icon,
  Tick02Icon,
  UserMultiple02Icon,
  ViewIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@dodocode/ui/components/message-scroller";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";
import {
  changeThreadSettings,
  moveTask,
  projects,
  setWorkspace,
  settings as settingsRows,
  splitItem,
  startReview,
  startTask,
  threads,
} from "../server/app-data";
import {
  interrupt,
  removeQueued,
  sendMessage,
  steerQueued,
  threadData,
} from "../server/thread-data";
import { GROUP_LABEL, reviewable } from "../task-list";
import { StatusGlyph } from "../task-ui";
import { openThread } from "../view";
import { latestTodos, toBlocks, type Block } from "./blocks";
import { clearDraft, Composer, readyDraft } from "./composer";
import { DetailsButton, DetailsCard } from "./details";
import { ImageGallery, Images } from "./image-view";
import { BlockView, Working } from "./messages";
import { ReviewerAccess } from "./pickers";
import { SidePanel, useSidePanel } from "./side-panel";
import { changesToShow, MergeButton, workPlace, workspaceSlots } from "./workspace";

export function ThreadView({
  threadId,
  inputRef,
}: {
  threadId: string;
  inputRef: Ref<HTMLTextAreaElement>;
}) {
  const hotkeys = useAppHotkeys();
  const {
    measure,
    open: panelKeptOpen,
    over,
    toggle: togglePanel,
    show: showPanel,
    close: closePanel,
  } = useSidePanel();
  const data = threadData(threadId);
  const { data: thread } = useLiveQuery({
    queryKey: ["thread", threadId],
    query: (q) =>
      q
        .from({ row: threads })
        .where(({ row }) => eq(row.id, threadId))
        .findOne(),
  });
  const items = useLiveQuery({
    queryKey: ["items", threadId],
    query: (q) => q.from({ item: data.items }).orderBy(({ item }) => item.seq, "asc"),
  });
  const { data: queue = [] } = useLiveQuery({
    queryKey: ["queue", threadId],
    query: (q) => q.from({ entry: data.queue }).orderBy(({ entry }) => entry.createdAt, "asc"),
  });
  const { data: jobs = [] } = useLiveQuery({
    queryKey: ["jobs", threadId],
    query: (q) => q.from({ job: data.jobs }).orderBy(({ job }) => job.startedAt, "asc"),
  });
  const projectId = thread?.projectId ?? "";
  const { data: project } = useLiveQuery({
    queryKey: ["project", projectId],
    query: (q) =>
      q
        .from({ row: projects })
        .where(({ row }) => eq(row.id, projectId))
        .findOne(),
  });
  const { data: saved } = useLiveQuery({
    queryKey: ["settings"],
    query: (q) => q.from({ row: settingsRows }).findOne(),
  });

  // The panel shows what the work changed, so it has nothing to show before the work starts.
  const panelShows = !!thread && !!project && changesToShow(workPlace(thread, project));
  useHotkey(hotkeys["panel.toggle"], togglePanel, { enabled: panelShows });

  // The app's list loads first, and the window leaves a thread that is gone.
  if (!thread) return null;

  const itemList = items.data ?? [];
  const running = thread.status === "running" || thread.status === "waiting";
  // A task nobody started has no messages yet, only what it covers.
  const fresh = unstarted(thread) && itemList.length === 0;
  const workMode = thread.workspace ?? saved?.workspace ?? "worktree";
  const slots = workspaceSlots({
    thread,
    project,
    mode: workMode,
    onModeChange: (workspace) => setWorkspace(threadId, workspace),
    onShowChanges: showPanel,
  });
  const panelOpen = panelShows && panelKeptOpen;

  return (
    <ImageGallery>
      <div className="grid h-full min-h-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
        <ThreadHeader
          thread={thread}
          project={project}
          details={<DetailsButton jobs={jobs} />}
          panel={panelShows ? { open: panelOpen, toggle: togglePanel } : undefined}
        />
        <div ref={measure} className="relative flex min-h-0">
          <div className="relative grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)_auto]">
            <DetailsCard
              thread={thread}
              project={project}
              todos={latestTodos(itemList)}
              jobs={jobs}
              mode={workMode}
              onShowChanges={showPanel}
            />
            {items.isLoadingError ? (
              <div className="grid place-items-center p-8 text-center text-muted-foreground">
                This thread could not be opened. It may have been deleted.
              </div>
            ) : !items.isReady ? (
              <div className="grid place-items-center">
                <Spinner className="size-5 text-muted-foreground" />
              </div>
            ) : fresh ? (
              <TaskBrief thread={thread} />
            ) : (
              <Transcript key={threadId} thread={thread} items={itemList} />
            )}
            <div className="mx-auto w-full max-w-3xl px-5 pb-4">
              {thread.kind === "subagent" ? (
                <SubagentNote thread={thread} />
              ) : (
                <>
                  {queue.length > 0 && (
                    <QueueList threadId={threadId} queue={queue} running={running} />
                  )}
                  {fresh ? (
                    <Composer
                      draftKey={threadId}
                      projectId={thread.projectId}
                      settings={thread.settings}
                      onSettingsChange={(settings) => changeThreadSettings(threadId, settings)}
                      running={false}
                      placeholder="Add anything else the agent should know, then start"
                      sendLabel="Start"
                      allowEmpty
                      {...slots}
                      onSend={(message) =>
                        startTask(
                          thread,
                          message.text || message.images.length > 0 ? message : undefined,
                        )
                      }
                      inputRef={inputRef}
                    />
                  ) : (
                    <Composer
                      draftKey={threadId}
                      projectId={thread.projectId}
                      context={thread.context}
                      settings={thread.settings}
                      onSettingsChange={(settings) => changeThreadSettings(threadId, settings)}
                      running={running}
                      placeholder={
                        running ? "Add to what the agent is doing" : "Reply to the agent"
                      }
                      onSend={(message, mode) => sendMessage(threadId, message, mode)}
                      onStop={() => interrupt(threadId)}
                      inputRef={inputRef}
                      {...slots}
                      access={
                        thread.kind === "review" ? (
                          <ReviewerAccess provider={thread.settings.provider} />
                        ) : undefined
                      }
                    />
                  )}
                </>
              )}
            </div>
          </div>
          {panelOpen && over && (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Hide the panel"
              className="absolute inset-0 z-10 cursor-default bg-black/10 dark:bg-black/30"
              onClick={closePanel}
            />
          )}
          {panelOpen && project && (
            <SidePanel thread={thread} project={project} over={over} onClose={closePanel} />
          )}
        </div>
      </div>
    </ImageGallery>
  );
}

/** How long a fold in the transcript takes to open or close, with a frame or two to spare. */
const FOLD_MS = 300;

/**
 * Opening or closing a fold changes the height of the transcript, and two things would then move
 * the fold away from under the pointer: the scroller following its end, and the browser keeping
 * what is below the fold in place (scroll anchoring). So a fold stops the scroller following, as
 * scrolling does, and it follows again once the fold has stopped moving and the person is back
 * at the end. The browser keeps nothing in place until the next scroll: the place it kept before
 * the click would pull the fold up the next time anything changes.
 */
function useFoldsStayPut() {
  const [moving, setMoving] = useState(false);
  const [unanchored, setUnanchored] = useState(false);
  const timer = useRef<number>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  function onClickCapture(event: MouseEvent<HTMLDivElement>) {
    if (!(event.target instanceof Element)) return;
    if (!event.target.closest('[data-slot$="collapsible-trigger"]')) return;
    // The scroller takes a wheel event as the person scrolling, and stops following the end.
    event.currentTarget.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    setMoving(true);
    setUnanchored(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMoving(false), FOLD_MS);
  }

  function onScroll() {
    // A scroll makes the browser pick a new place to keep, so it can keep places again.
    if (unanchored && !moving) setUnanchored(false);
  }

  return { moving, unanchored, onClickCapture, onScroll };
}

/** The newest blocks a thread opens on. Building all 160 of a long thread took 0.1-0.2s. */
const FIRST_BLOCKS = 40;
/** How many older blocks join at a time. */
const MORE_BLOCKS = 40;

const ITEM = '[data-slot="message-scroller-item"]';
const CONTENT = '[data-slot="message-scroller-content"]';

/**
 * The first block to show. A thread opens on its newest blocks, and older ones join as the reader
 * scrolls within a viewport's height of the top. They also join while the blocks shown fill less
 * than two viewports, so there is always room to scroll up: as blocks join, and whenever the
 * blocks or the viewport change size without a scroll, as when a fold closes or the window grows.
 *
 * The browser keeps the view in place as blocks join above it (scroll anchoring), also while a
 * wheel scroll is still moving. While a fold stops it doing that (`unanchored`, see
 * useFoldsStayPut), the view is kept in place here, so the fold stays under the pointer.
 */
function useOlderBlocks(count: number, unanchored: boolean) {
  const [first, setFirst] = useState(() => Math.max(0, count - FIRST_BLOCKS));
  // A thread that lost blocks still shows its newest ones.
  const start = Math.min(first, Math.max(0, count - FIRST_BLOCKS));
  const viewport = useRef<HTMLDivElement>(null);
  // The block that was first as older ones were asked for, where it was in the transcript, and
  // the first block asked for.
  const kept = useRef<{ item: Element; place: number; start: number } | undefined>(undefined);

  function more(element: HTMLDivElement) {
    if (start === 0) return;
    const next = Math.max(0, start - MORE_BLOCKS);
    const item = element.querySelector(ITEM);
    kept.current = item ? { item, place: placeOf(item, element), start: next } : undefined;
    setFirst(next);
  }

  const fill = useEffectEvent(() => {
    const element = viewport.current;
    if (element && element.scrollHeight < element.clientHeight * 2) more(element);
  });

  /** Runs once the blocks from `shown` on are in the page. */
  const joined = useEffectEvent((shown: number) => {
    const element = viewport.current;
    const was = kept.current;
    if (element && was?.start === shown) {
      kept.current = undefined;
      // The blocks that joined pushed it down by their height: scroll down as far.
      if (unanchored) element.scrollTop += placeOf(was.item, element) - was.place;
    }
    fill();
  });

  useLayoutEffect(() => joined(start), [start]);

  useEffect(() => {
    const element = viewport.current;
    const content = element?.querySelector(CONTENT);
    if (!element || !content) return;
    const observer = new ResizeObserver(() => fill());
    observer.observe(element);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  function onScroll(event: UIEvent<HTMLDivElement>) {
    const element = event.currentTarget;
    if (element.scrollTop < element.clientHeight) more(element);
  }

  return { start, viewport, onScroll };
}

/** Where an element is in a scroller's content, wherever the scroller is scrolled to. */
function placeOf(element: Element, scroller: Element): number {
  return (
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

/** The transcript's blocks. Those that show the same as last time stay as they were, to skip drawing. */
function useBlocks(items: Item[], running: boolean): Block[] {
  const [drawn, setDrawn] = useState(() => ({ items, running, blocks: toBlocks(items, running) }));
  if (drawn.items === items && drawn.running === running) return drawn.blocks;
  const blocks = toBlocks(items, running, drawn.blocks);
  setDrawn({ items, running, blocks });
  return blocks;
}

function Transcript({ thread, items }: { thread: Thread; items: Item[] }) {
  const running = thread.status === "running";
  const blocks = useBlocks(items, running);
  const folds = useFoldsStayPut();
  const { viewport: olderViewport, ...older } = useOlderBlocks(blocks.length, folds.unanchored);
  const last = items.at(-1);
  const streamingText = last?.type === "assistant" && last.streaming && last.text.length > 0;
  const showWorking = running && !streamingText;
  const turnStart = last ? items.find((item) => item.turnId === last.turnId)?.createdAt : undefined;

  return (
    <MessageScrollerProvider
      autoScroll={!folds.moving}
      defaultScrollPosition="end"
      scrollPreviousItemPeek={48}
    >
      <MessageScroller>
        <MessageScrollerViewport
          ref={olderViewport}
          className={cn(folds.unanchored && "[overflow-anchor:none]")}
          onClickCapture={folds.onClickCapture}
          onScroll={(event) => {
            folds.onScroll();
            older.onScroll(event);
          }}
        >
          <MessageScrollerContent className="mx-auto w-full max-w-3xl gap-5 px-6 pt-6 pb-8">
            {blocks.length === 0 && !showWorking && (
              <p className="m-auto text-muted-foreground">Nothing here yet.</p>
            )}
            {blocks.slice(older.start).map((block) => (
              <MessageScrollerItem
                key={block.id}
                messageId={block.id}
                scrollAnchor={block.kind === "user"}
              >
                <BlockView block={block} />
              </MessageScrollerItem>
            ))}
            {showWorking && (
              <MessageScrollerItem>
                <Working
                  since={turnStart}
                  waiting={false}
                  label={thread.context?.compacting ? "Compacting the conversation" : undefined}
                />
              </MessageScrollerItem>
            )}
            {thread.status === "error" && thread.error && (
              <MessageScrollerItem>
                <p className="rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-2.5 text-[13px] whitespace-pre-wrap text-destructive">
                  {thread.error}
                </p>
              </MessageScrollerItem>
            )}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton direction="end" />
      </MessageScroller>
    </MessageScrollerProvider>
  );
}

function ThreadHeader({
  thread,
  project,
  details,
  panel,
}: {
  thread: Thread;
  project: Project | undefined;
  /** The button that opens the thread's details. */
  details: ReactNode;
  /** The panel beside the conversation, when it has something to show. */
  panel: { open: boolean; toggle: () => void } | undefined;
}) {
  const hotkeys = useAppHotkeys();
  const parentId = thread.parentId;
  const back = thread.kind === "review" ? "Back to the task" : "Back to the thread that started it";
  const panelLabel = panel?.open ? "Hide the panel" : "Show what changed, in a panel";

  return (
    <header className="flex h-11 min-w-0 items-center gap-2 border-b px-4">
      {parentId && (
        <Tip label={back}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={back}
            onClick={() => openThread(parentId)}
          >
            <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
          </Button>
        </Tip>
      )}
      {thread.kind !== "main" ? (
        <HugeiconsIcon
          icon={thread.kind === "review" ? InspectCodeIcon : UserMultiple02Icon}
          strokeWidth={1.8}
          aria-label={thread.kind === "review" ? "A review" : "A subagent"}
          className="size-4 shrink-0 text-muted-foreground"
        />
      ) : (
        thread.task && (
          <Tip label={GROUP_LABEL[thread.task.status]}>
            <span className="grid shrink-0 place-items-center">
              <StatusGlyph status={thread.task.status} />
              <span className="sr-only">{GROUP_LABEL[thread.task.status]}</span>
            </span>
          </Tip>
        )
      )}
      <h1 className="min-w-0 truncate font-medium">{thread.title}</h1>
      {project && <span className="shrink-0 text-muted-foreground">{project.name}</span>}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {thread.kind === "main" && <ReviewButton thread={thread} />}
        {thread.kind === "main" && <PrimaryAction thread={thread} />}
        {details}
        {panel && (
          <Tip label={panelLabel} hotkey={hotkeys["panel.toggle"]}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={panelLabel}
              aria-expanded={panel.open}
              className={cn("text-muted-foreground", panel.open && "bg-muted text-foreground")}
              onClick={panel.toggle}
            >
              <HugeiconsIcon icon={SidebarRightIcon} strokeWidth={1.8} />
            </Button>
          </Tip>
        )}
      </div>
    </header>
  );
}

/**
 * The steps that come next for a task: start it; put it in review and finish it; or open it
 * again. Nothing moves to review on its own: the person does it here, or asks the agent to.
 */
function PrimaryAction({ thread }: { thread: Thread }) {
  if (!thread.task) return null;
  if (unstarted(thread)) {
    return (
      <Button
        size="sm"
        onClick={() => {
          const extra = readyDraft(thread.id);
          void startTask(thread, extra).then((ok) => ok && clearDraft(thread.id));
        }}
      >
        Start
      </Button>
    );
  }
  if (thread.task.status === "done") {
    // Merged work is gone from its worktree, so there is nothing to reopen there.
    if (thread.worktree?.mergedAt !== undefined) return null;
    return (
      <Button variant="outline" size="sm" onClick={() => void moveTask(thread, "progress")}>
        Reopen
      </Button>
    );
  }
  // Work in a worktree is done once it is back on its branch. With nothing changed, there is
  // nothing to merge, and it is done as it is.
  const worktree = thread.worktree;
  const finish =
    worktree?.base && worktree.mergedAt === undefined && (worktree.changed?.files ?? 1) > 0 ? (
      <MergeButton thread={thread} />
    ) : (
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        onClick={() => void moveTask(thread, "done", true)}
      >
        <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
        Mark done
      </Button>
    );
  if (thread.task.status !== "progress") return finish;
  return (
    <>
      <Tip label="Put it in In review, to look over before it's done">
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5"
          onClick={() => void moveTask(thread, "review", true)}
        >
          <HugeiconsIcon icon={ViewIcon} strokeWidth={1.8} />
          Move to review
        </Button>
      </Tip>
      {finish}
    </>
  );
}

/**
 * Starts a fresh agent reviewing a task in review, or opens the review that runs. What it finds
 * goes to the task's agent.
 */
function ReviewButton({ thread }: { thread: Thread }) {
  const [starting, setStarting] = useState(false);
  const { data: reviews = [] } = useLiveQuery({
    queryKey: ["reviews", thread.id],
    query: (q) =>
      q
        .from({ row: threads })
        .where(({ row }) => and(eq(row.kind, "review"), eq(row.parentId, thread.id)))
        .orderBy(({ row }) => row.createdAt, "desc"),
  });
  const latest = reviews[0];
  if (latest && (latest.status === "running" || latest.status === "waiting")) {
    return (
      <Tip label="Open the review">
        <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => openThread(latest.id)}>
          <Spinner className="size-3.5" />
          Reviewing
        </Button>
      </Tip>
    );
  }
  if (!reviewable(thread) || thread.task?.status !== "review") return null;
  const start = async () => {
    setStarting(true);
    const review = await startReview(thread);
    setStarting(false);
    if (review) openThread(review.id);
  };
  return (
    <Tip label="A fresh agent reviews the work, and what it finds goes to this task's agent">
      <Button
        variant="outline"
        size="sm"
        className="gap-1.5"
        disabled={starting}
        onClick={() => void start()}
      >
        {starting ? (
          <Spinner className="size-3.5" />
        ) : (
          <HugeiconsIcon icon={InspectCodeIcon} strokeWidth={1.8} />
        )}
        Review
      </Button>
    </Tip>
  );
}

/** A task nobody started: what it covers, each part able to go off as a task of its own. */
function TaskBrief({ thread }: { thread: Thread }) {
  const covers = thread.task?.covers ?? [];
  return (
    <div className="min-h-0 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pt-8 pb-6">
        <p className="text-[12.5px] text-muted-foreground">
          {thread.task?.status === "backlog"
            ? "In the backlog: an idea, not planned yet. Move it to To do when it's worth doing, or start it now: Start sends it to the agent, with anything you add below."
            : covers.length > 1
              ? `In To do, covering ${covers.length} things as one piece of work. Start sends them all to the agent, with anything you add below.`
              : "In To do. Start sends this to the agent, with anything you add below."}
        </p>
        <ol className="flex flex-col gap-2">
          {covers.map((item) => {
            const rest = item.body?.startsWith(item.title)
              ? item.body.slice(item.title.length).trim()
              : item.body;
            return (
              <li
                key={item.id}
                className="flex flex-col gap-2 rounded-xl border bg-card px-3.5 py-3"
              >
                <div className="flex items-start gap-2">
                  <h2 className="min-w-0 flex-1 font-medium">{item.title}</h2>
                  {covers.length > 1 && (
                    <Tip label="Make it a task of its own, in To do">
                      <Button
                        variant="ghost"
                        size="xs"
                        className="-my-0.5 gap-1 text-muted-foreground"
                        onClick={() => void splitItem(thread.id, item.id)}
                      >
                        <HugeiconsIcon icon={Scissor01Icon} strokeWidth={1.8} />
                        Split off
                      </Button>
                    </Tip>
                  )}
                </div>
                {rest && (
                  <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
                    {rest}
                  </p>
                )}
                {item.images && item.images.length > 0 && (
                  <Images images={item.images} align="start" />
                )}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}

function QueueList({
  threadId,
  queue,
  running,
}: {
  threadId: string;
  queue: QueuedMessage[];
  running: boolean;
}) {
  return (
    <ul aria-label="Queued messages" className="mb-2 flex flex-col gap-1">
      {queue.map((entry) => (
        <li
          key={entry.id}
          className="flex min-w-0 items-center gap-2 rounded-xl border bg-muted/40 py-1 pr-1 pl-3 text-[13px]"
        >
          <HugeiconsIcon
            icon={Clock01Icon}
            strokeWidth={1.8}
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate">
            {entry.app
              ? entry.app.kind === "review"
                ? "What the reviewer is asked"
                : "A review's findings"
              : entry.text ||
                `${entry.images.length} ${entry.images.length === 1 ? "image" : "images"}`}
          </span>
          {running && (
            <Tip label="Send it into the running turn now">
              <Button variant="ghost" size="xs" onClick={() => steerQueued(threadId, entry.id)}>
                <HugeiconsIcon icon={SteeringIcon} strokeWidth={1.8} data-icon="inline-start" />
                Send now
              </Button>
            </Tip>
          )}
          <Tip label="Remove">
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Remove the queued message"
              onClick={() => removeQueued(threadId, entry.id)}
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </Tip>
        </li>
      ))}
    </ul>
  );
}

function SubagentNote({ thread }: { thread: Thread }) {
  const parentId = thread.parentId;
  return (
    <div className="flex items-center gap-2 rounded-xl border bg-muted/40 px-3.5 py-2.5 text-[13px] text-muted-foreground">
      <HugeiconsIcon icon={UserMultiple02Icon} strokeWidth={1.8} className="size-4 shrink-0" />
      <span className="flex-1">A subagent did this work. Its thread takes no messages.</span>
      {parentId && (
        <Button variant="outline" size="xs" onClick={() => openThread(parentId)}>
          Go to the main thread
        </Button>
      )}
    </div>
  );
}
