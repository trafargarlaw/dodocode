import { useState, type DragEvent } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { unstarted, type Project, type TaskStatus, type Thread } from "@dodocode/protocol";
import {
  Add01Icon,
  ArchiveArrowUpIcon,
  ArrowLeft01Icon,
  BotIcon,
  Cancel01Icon,
  MoreHorizontalIcon,
  PinIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { Checkbox } from "@dodocode/ui/components/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import { toast } from "@dodocode/ui/components/toast";
import { cn } from "@dodocode/ui/lib/utils";
import { loadBoard, saveBoard } from "./board-layout";
import { Keys, Tip } from "./keys";
import { setListFilter, useListFilter } from "./list-filter";
import { ProjectPicker } from "./project-picker";
import {
  createIdea,
  createTask,
  mergeTasks,
  moveTask,
  projects,
  setNotDoing,
  startTask,
  threads,
} from "./server/app-data";
import { boardColumns, canMerge, COLUMNS, dropOf, GROUP_LABEL } from "./task-list";
import { Attention, MoveItems, StatusGlyph } from "./task-ui";
import { ago, useNow } from "./time";
import { openThread } from "./view";

/** How many done tasks show before "Show more". */
const DONE_LIMIT = 20;

/**
 * The tasks as cards in four columns, and the backlog left of them when it is open. Dragging a
 * card moves it, or folds it into another.
 */
export function BoardView() {
  const filter = useListFilter();
  const now = useNow();
  const { data: projectList = [] } = useLiveQuery({
    query: (q) => q.from({ project: projects }).orderBy(({ project }) => project.createdAt, "asc"),
  });
  const { data: threadList = [] } = useLiveQuery({
    query: (q) => q.from({ thread: threads }).orderBy(({ thread }) => thread.activityAt, "desc"),
  });
  const [dragged, setDragged] = useState<Thread>();
  /** The column, or the card, the dragged card would land on. */
  const [over, setOver] = useState<string>();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [allDone, setAllDone] = useState(false);
  const [backlogOpen, setBacklogOpen] = useState(() => loadBoard().backlog);
  const [showNotDoing, setShowNotDoing] = useState(false);

  const showBacklog = (open: boolean) => {
    setBacklogOpen(open);
    saveBoard({ backlog: open });
  };

  // The board shows every task of the project; "Needs you" narrows only the sidebar.
  const columns = boardColumns(threadList, { projectId: filter.projectId, needsYou: false });
  const names = new Map(projectList.map((project) => [project.id, project.name]));
  const titles = new Map(threadList.map((thread) => [thread.id, thread.title]));
  const shown: readonly TaskStatus[] = backlogOpen ? ["backlog", ...COLUMNS] : COLUMNS;
  const mixed = !filter.projectId && projectList.length > 1;
  // In the order they were picked, so the first one picked is the one the rest fold into.
  const chosen = [...selected].flatMap((id) => {
    const card = columns.todo.find((entry) => entry.id === id);
    return card && unstarted(card) ? [card] : [];
  });
  const empty = COLUMNS.every((status) => columns[status].length === 0);

  const endDrag = () => {
    setDragged(undefined);
    setOver(undefined);
  };

  const drop = async (card: Thread, target: TaskStatus | Thread) => {
    endDrag();
    const result = dropOf(card, target);
    switch (result.kind) {
      case "none":
        return;
      case "start":
        await startTask(card);
        return;
      case "move":
        await moveTask(
          card,
          result.status,
          result.status === "done" || result.status === "backlog",
        );
        return;
      case "merge":
        if (await mergeTasks(result.into.id, [card.id])) {
          toast.add({ title: `Added to “${result.into.title}”`, description: card.title });
        }
        return;
    }
  };

  const toggle = (card: Thread) =>
    setSelected((current) => {
      const next = new Set(current);
      if (!next.delete(card.id)) next.add(card.id);
      return next;
    });

  /** The task whose agent wrote this one down, when one did. */
  const noticedIn = (card: Thread) => {
    const id = card.task?.suggestedBy;
    return id ? (titles.get(id) ?? "a task that's gone") : undefined;
  };

  /** Folds the chosen tasks into the first one picked, and starts it when asked. */
  const together = async (start: boolean) => {
    const [first, ...rest] = chosen;
    if (!first) return;
    const merged =
      rest.length > 0
        ? await mergeTasks(
            first.id,
            rest.map((card) => card.id),
          )
        : first;
    if (!merged) return;
    setSelected(new Set());
    if (start && (await startTask(merged))) openThread(merged.id);
  };

  return (
    <div className="grid h-full min-h-0 grid-rows-[auto_minmax(0,1fr)]">
      <header className="flex h-11 min-w-0 items-center gap-3 border-b px-4">
        <h1 className="font-medium">Board</h1>
        <ProjectPicker
          value={filter.projectId ?? null}
          onChange={(projectId) => setListFilter({ projectId: projectId ?? undefined })}
          projects={projectList}
          none="All projects"
          className="h-7 border-transparent bg-transparent text-[12.5px] text-muted-foreground shadow-none hover:bg-muted hover:text-foreground"
        />
        <Tip label={backlogOpen ? "Hide the backlog" : "Show the backlog: ideas not planned yet"}>
          <Button
            variant="ghost"
            size="sm"
            aria-pressed={backlogOpen}
            onClick={() => showBacklog(!backlogOpen)}
            className="gap-1.5 text-[12.5px] font-normal text-muted-foreground aria-pressed:bg-muted aria-pressed:text-foreground"
          >
            <StatusGlyph status="backlog" />
            Backlog
            <span className="text-[12px] text-muted-foreground tabular-nums">
              {columns.backlog.length}
            </span>
          </Button>
        </Tip>
        <p className="ml-auto hidden truncate text-[12px] text-muted-foreground lg:block">
          Drag a card to move it. Drop a task nobody started on another to do them as one.
        </p>
      </header>
      <div className="grid min-h-0 auto-cols-[minmax(220px,1fr)] grid-flow-col gap-3 overflow-x-auto p-3">
        {shown.map((status) => {
          const cards =
            status === "done" && !allDone ? columns.done.slice(0, DONE_LIMIT) : columns[status];
          const target = `column:${status}`;
          const takes = dragged !== undefined && dropOf(dragged, status).kind !== "none";
          return (
            // Dragging is for the mouse; each card's menu moves it from the keyboard.
            // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
            <section
              key={status}
              aria-label={GROUP_LABEL[status]}
              onDragOver={(event) => {
                if (!takes) return;
                event.preventDefault();
                setOver(target);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                  setOver((current) => (current === target ? undefined : current));
                }
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragged) void drop(dragged, status);
              }}
              className={cn(
                "flex min-h-0 flex-col rounded-xl bg-muted/45 ring-1 ring-transparent transition-colors dark:bg-muted/25",
                over === target && takes && "bg-muted ring-ring/40",
              )}
            >
              <div className="flex min-h-9 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1">
                <StatusGlyph status={status} />
                <h2 className="text-[12.5px] font-medium whitespace-nowrap">
                  {GROUP_LABEL[status]}
                </h2>
                <span className="text-[12px] text-muted-foreground tabular-nums">
                  {columns[status].length}
                </span>
                {status === "backlog" && (
                  <Tip label="Hide the backlog">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Hide the backlog"
                      onClick={() => showBacklog(false)}
                      className="-mr-1.5 ml-auto text-muted-foreground"
                    >
                      <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
                    </Button>
                  </Tip>
                )}
                {status === "todo" && chosen.length > 0 && (
                  <div className="ml-auto flex items-center gap-1">
                    {chosen.length > 1 && (
                      <Button size="xs" variant="ghost" onClick={() => void together(false)}>
                        Combine
                      </Button>
                    )}
                    <Button size="xs" onClick={() => void together(true)}>
                      {chosen.length > 1 ? `Start ${chosen.length} as one` : "Start"}
                    </Button>
                  </div>
                )}
              </div>
              <ul className="flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto px-2 pb-2">
                {cards.map((card) => (
                  <Card
                    key={card.id}
                    card={card}
                    now={now}
                    project={mixed && card.projectId ? names.get(card.projectId) : undefined}
                    from={noticedIn(card)}
                    selecting={selected.size > 0}
                    selected={selected.has(card.id)}
                    onToggle={() => toggle(card)}
                    dragged={dragged}
                    over={over === card.id}
                    onDragStart={() => setDragged(card)}
                    onDragEnd={endDrag}
                    onOver={(on) =>
                      setOver((current) =>
                        on ? card.id : current === card.id ? undefined : current,
                      )
                    }
                    onDrop={(from) => void drop(from, card)}
                  />
                ))}
                {cards.length === 0 && (
                  <li className="px-1.5 py-3 text-center text-[12px] text-muted-foreground">
                    {dragged && takes
                      ? "Drop here"
                      : status === "backlog"
                        ? "Write down what might be worth doing. Nothing here is planned."
                        : status === "todo" && empty
                          ? "Add what needs doing, and start it when you're ready."
                          : "Nothing here"}
                  </li>
                )}
                {status === "backlog" && columns.notDoing.length > 0 && (
                  <li>
                    <button
                      type="button"
                      aria-expanded={showNotDoing}
                      onClick={() => setShowNotDoing(!showNotDoing)}
                      className="h-7 w-full rounded-lg text-[12px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {showNotDoing ? "Hide not doing" : `${columns.notDoing.length} not doing`}
                    </button>
                  </li>
                )}
                {status === "backlog" &&
                  showNotDoing &&
                  columns.notDoing.map((card) => (
                    <Card
                      key={card.id}
                      card={card}
                      now={now}
                      project={mixed && card.projectId ? names.get(card.projectId) : undefined}
                      from={noticedIn(card)}
                      notDoing
                      selecting={false}
                      selected={false}
                      onToggle={() => {}}
                      dragged={dragged}
                      over={false}
                      onDragStart={() => {}}
                      onDragEnd={endDrag}
                      onOver={() => {}}
                      onDrop={() => {}}
                    />
                  ))}
                {status === "done" && columns.done.length > DONE_LIMIT && (
                  <li>
                    <button
                      type="button"
                      onClick={() => setAllDone(!allDone)}
                      className="h-7 w-full rounded-lg text-[12px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {allDone ? "Show fewer" : `Show ${columns.done.length - DONE_LIMIT} more`}
                    </button>
                  </li>
                )}
              </ul>
              {(status === "todo" || status === "backlog") && (
                <AddTask
                  idea={status === "backlog"}
                  projectId={filter.projectId}
                  projects={projectList}
                  threads={threadList}
                />
              )}
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({
  card,
  now,
  project,
  from,
  notDoing = false,
  selecting,
  selected,
  onToggle,
  dragged,
  over,
  onDragStart,
  onDragEnd,
  onOver,
  onDrop,
}: {
  card: Thread;
  now: number;
  project: string | undefined;
  /** The task whose agent wrote this idea down. */
  from: string | undefined;
  /** An idea set aside, shown under "Not doing". */
  notDoing?: boolean;
  selecting: boolean;
  selected: boolean;
  onToggle: () => void;
  dragged: Thread | undefined;
  over: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onOver: (on: boolean) => void;
  onDrop: (from: Thread) => void;
}) {
  const fresh = unstarted(card);
  const covers = card.task?.covers.length ?? 0;
  const mergeable = !notDoing && dragged !== undefined && canMerge(dragged, card);

  // A card takes the drop only when the dragged one can fold into it; otherwise the column does.
  const onDragOver = (event: DragEvent) => {
    if (!mergeable) return;
    event.preventDefault();
    event.stopPropagation();
    onOver(true);
  };

  return (
    // Dragging is for the mouse; the card's menu moves it from the keyboard.
    // oxlint-disable-next-line jsx-a11y/no-noninteractive-element-interactions
    <li
      draggable={!notDoing}
      onDragStart={(event) => {
        event.dataTransfer.setData("text/plain", card.title);
        event.dataTransfer.effectAllowed = "move";
        onDragStart();
      }}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onOver(false);
      }}
      onDrop={(event) => {
        if (!mergeable || !dragged) return;
        event.preventDefault();
        event.stopPropagation();
        onDrop(dragged);
      }}
      className={cn(
        "group/card relative rounded-lg border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.04)] transition",
        dragged?.id === card.id && "opacity-50",
        over && "border-primary ring-3 ring-primary/20",
        selected && "border-primary/60",
        notDoing && "bg-transparent shadow-none",
      )}
    >
      <button
        type="button"
        onClick={(event) => {
          if (fresh && (selecting || event.shiftKey || event.metaKey || event.ctrlKey)) onToggle();
          else openThread(card.id);
        }}
        className="flex w-full flex-col gap-1.5 rounded-lg px-2.5 py-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="flex items-start gap-1.5">
          <span
            className={cn(
              "line-clamp-3 min-w-0 flex-1 pr-5 text-[13px] leading-snug",
              notDoing && "text-muted-foreground line-through",
            )}
          >
            {card.title}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11.5px] text-muted-foreground">
          <Attention thread={card} />
          {card.pinned && (
            <HugeiconsIcon
              icon={PinIcon}
              strokeWidth={1.8}
              aria-label="Pinned"
              className="size-3"
            />
          )}
          {project && <span className="truncate">{project}</span>}
          {from && (
            <span
              className="flex min-w-0 items-center gap-1"
              title={`An agent noticed it, working on “${from}”`}
            >
              <HugeiconsIcon
                icon={BotIcon}
                strokeWidth={1.8}
                aria-hidden
                className="size-3 shrink-0"
              />
              <span className="truncate">From {from}</span>
            </span>
          )}
          {covers > 1 && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 leading-4.5 tabular-nums">
              {covers} items
            </span>
          )}
          {fresh && card.task?.status !== "todo" && card.task?.status !== "backlog" && (
            <span className="shrink-0">Not started</span>
          )}
          <span className="ml-auto shrink-0 tabular-nums">{ago(card.activityAt, now)}</span>
        </span>
      </button>
      {over && (
        <span className="pointer-events-none absolute inset-x-0 -bottom-2.5 mx-auto w-fit rounded-full bg-primary px-2 text-[11px] leading-5 font-medium text-primary-foreground shadow">
          Do as one
        </span>
      )}
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {fresh && card.task?.status === "todo" && (
          <Checkbox
            aria-label={`Choose ${card.title}`}
            checked={selected}
            onCheckedChange={onToggle}
            className={cn(
              "transition-opacity",
              !selecting && "opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100",
            )}
          />
        )}
        {!selecting && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`${card.title} actions`}
                  className="text-muted-foreground opacity-0 group-hover/card:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-40">
              {notDoing ? (
                <DropdownMenuItem onClick={() => setNotDoing(card, false)}>
                  <HugeiconsIcon icon={ArchiveArrowUpIcon} strokeWidth={1.8} />
                  Back to the backlog
                </DropdownMenuItem>
              ) : (
                <>
                  <MoveItems thread={card} />
                  {card.task?.status === "backlog" && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onClick={() => setNotDoing(card, true)}>
                        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={1.8} />
                        Not doing
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </li>
  );
}

/** Adds tasks to To do, or ideas to the backlog, one after another, without starting them. */
function AddTask({
  idea = false,
  projectId,
  projects: projectList,
  threads: threadList,
}: {
  idea?: boolean;
  projectId: string | undefined;
  projects: Project[];
  threads: Thread[];
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  // The filter's project, or the one picked here, or the one worked in last.
  const fallback =
    threadList.find((thread) => thread.projectId)?.projectId ?? projectList[0]?.id ?? null;
  const target = projectId ?? picked ?? fallback;

  const submit = async () => {
    if (!target || !text.trim() || adding) return;
    setAdding(true);
    const message = { text, images: [] };
    const task = idea ? await createIdea(target, message) : await createTask(target, message);
    setAdding(false);
    if (task) setText("");
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mx-2 mb-2 flex h-8 shrink-0 items-center gap-1.5 rounded-lg px-2 text-[12.5px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <HugeiconsIcon icon={Add01Icon} strokeWidth={2} className="size-3.5" />
        {idea ? "Add an idea" : "Add a task"}
      </button>
    );
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="@container mx-2 mb-2 flex shrink-0 flex-col gap-1.5 rounded-lg border bg-card p-1.5 focus-within:border-ring/70"
    >
      <textarea
        aria-label={idea ? "New idea" : "New task"}
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person asked to add a task
        autoFocus
        rows={2}
        value={text}
        placeholder={
          idea
            ? "What might be worth doing? The first line is its title."
            : "What needs doing? The first line is its title."
        }
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void submit();
          }
          if (event.key === "Escape") setOpen(false);
        }}
        className="field-sizing-content max-h-48 min-h-12 w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-snug outline-none placeholder:text-muted-foreground"
      />
      <div className="flex min-w-0 items-center gap-1">
        {!projectId && (
          <ProjectPicker
            value={target}
            onChange={setPicked}
            projects={projectList}
            side="top"
            className="h-6.5 min-w-0 shrink border-transparent bg-transparent px-1.5 text-[12px] text-muted-foreground shadow-none hover:bg-muted"
          />
        )}
        {/* The column is as narrow as 220px with the backlog shown: the hint goes before the buttons do. */}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <span className="hidden items-center gap-1 text-[11px] text-muted-foreground @min-[15rem]:inline-flex">
            <Keys hotkey="Enter" /> adds
          </span>
          <Button type="button" size="xs" variant="ghost" onClick={() => setOpen(false)}>
            Done
          </Button>
          <Button
            type="submit"
            size="xs"
            disabled={!target || !text.trim() || adding}
            title={
              target
                ? undefined
                : `Add a project first: ${idea ? "an idea belongs" : "a task works"} in one`
            }
          >
            Add
          </Button>
        </div>
      </div>
    </form>
  );
}
