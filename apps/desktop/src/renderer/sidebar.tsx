import { useRef, useState, type ComponentProps, type ReactNode, type RefObject } from "react";
import { useAppHotkeys } from "@tanstack/react-hotkeys";
import { useLiveQuery } from "@tanstack/react-db";
import type { Project, Thread, ThreadStatus } from "@dodocode/protocol";
import {
  Add01Icon,
  Archive02Icon,
  ArchiveArrowUpIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  Delete02Icon,
  FilterIcon,
  Folder01Icon,
  FolderAddIcon,
  KanbanIcon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  PencilEdit02Icon,
  PinIcon,
  PinOffIcon,
  Tick02Icon,
  VisualStudioCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@dodocode/ui/components/alert-dialog";
import { Button } from "@dodocode/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@dodocode/ui/components/dropdown-menu";
import { cn } from "@dodocode/ui/lib/utils";
import { HeldKeys, Tip } from "./keys";
import { openPalette } from "./palette/palette";
import { setListFilter, useListFilter } from "./list-filter";
import {
  deleteThread,
  moveTask,
  openInEditor,
  projects,
  removeProject,
  renameThread,
  setArchived,
  setPinned,
  threads,
} from "./server/app-data";
import {
  GROUP_LABEL,
  needsYou,
  sidebarGroups,
  topThreadId,
  type GroupId,
  type ListFilter,
  type SidebarGroup,
} from "./task-list";
import { Attention, MoveItems, StatusGlyph } from "./task-ui";
import { ago, useNow } from "./time";
import { openBoard, openDraft, openThread, useView } from "./view";

/** How many threads a group lists before "Show more". */
const LIST_LIMIT = 8;
const COLLAPSED_KEY = "dodocode:collapsed-groups";
/** Done starts folded: what's finished matters less than what isn't. */
const COLLAPSED_AT_FIRST: GroupId[] = ["done"];

/**
 * The threads, as two lists: the tasks, by where each one is, and the chats. Above them, the
 * board, and the buttons that narrow the lists or start something, each an icon its tooltip names.
 */
export function Sidebar({ onNewThread }: { onNewThread: () => void }) {
  const hotkeys = useAppHotkeys();
  const view = useView();
  const now = useNow();
  const openId = view.kind === "thread" ? view.threadId : undefined;
  const filter = useListFilter();
  const { data: projectList = [] } = useLiveQuery({
    query: (q) => q.from({ project: projects }).orderBy(({ project }) => project.createdAt, "asc"),
  });
  const { data: threadList = [], isReady } = useLiveQuery({
    query: (q) => q.from({ thread: threads }).orderBy(({ thread }) => thread.activityAt, "desc"),
  });
  const collapsed = useCollapsedGroups();
  const [expanded, setExpanded] = useState<ReadonlySet<GroupId>>(new Set());
  const filterButton = useRef<HTMLButtonElement>(null);

  const groups = sidebarGroups(threadList, {
    openId,
    filter,
    expanded,
    limit: LIST_LIMIT,
    now,
  });
  const tasks = groups.filter((group) => group.id !== "chats" && group.id !== "done");
  const chats = groups.find((group) => group.id === "chats");
  // Done tasks go at the bottom, under the chats: finished, they need nothing more.
  const done = groups.find((group) => group.id === "done");
  // A subagent or a review has no row: the row of the thread it belongs to stands for it.
  const openTopId = openId ? topThreadId(threadList, openId) : undefined;
  const waiting = threadList.filter(
    (thread) =>
      needsYou(thread) &&
      !thread.archived &&
      (!filter.projectId || thread.projectId === filter.projectId),
  ).length;
  const filtered = filter.projectId !== undefined || filter.needsYou;

  const expand = (id: GroupId, on: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const rowsProps = (group: SidebarGroup) => ({
    group,
    expanded: expanded.has(group.id),
    onExpand: (on: boolean) => expand(group.id, on),
    openId,
    openTopId,
    now,
  });

  return (
    <nav aria-label="Threads" className="flex h-full min-h-0 flex-col px-2.5 pt-1.5 pb-2.5">
      {/* A place to go on the left. On the right, what narrows the lists, then what starts something. */}
      <div className="flex items-center gap-0.5">
        <SidebarRow
          icon={KanbanIcon}
          aria-current={view.kind === "board" ? "page" : undefined}
          className={cn(
            "min-w-0 flex-1",
            view.kind === "board" && "bg-sidebar-selected hover:bg-sidebar-selected",
          )}
          onClick={openBoard}
        >
          <span className="flex-1">Board</span>
        </SidebarRow>
        <FilterMenu
          projects={projectList}
          filter={filter}
          waiting={waiting}
          triggerRef={filterButton}
        />
        <Tip label="Add a project">
          <HeaderButton aria-label="Add a project" onClick={() => openPalette("add-project")}>
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.8} />
          </HeaderButton>
        </Tip>
        <Tip label="New thread" hotkey={hotkeys["thread.new"]}>
          <HeaderButton
            aria-label="New thread"
            aria-current={view.kind === "draft" ? "page" : undefined}
            onClick={onNewThread}
            className="aria-[current=page]:bg-sidebar-selected aria-[current=page]:text-sidebar-foreground"
          >
            <HugeiconsIcon icon={PencilEdit02Icon} strokeWidth={1.8} />
            <HeldKeys hotkey={hotkeys["thread.new"]} className="top-full right-0 mt-1" />
          </HeaderButton>
        </Tip>
      </div>

      <ActiveFilters
        project={projectList.find((entry) => entry.id === filter.projectId)}
        needsYou={filter.needsYou}
        openId={openId}
        // A chip goes once it clears its filter, so focus waits on the filter button instead.
        onCleared={() => filterButton.current?.focus()}
      />

      <div className="-mx-2.5 flex min-h-0 flex-1 flex-col overflow-y-auto px-2.5">
        {isReady &&
          (filter.needsYou && waiting === 0 ? (
            // The open thread still shows, so this says why nothing else does.
            <EmptyList text="Nothing needs you right now." />
          ) : groups.length === 0 ? (
            <EmptyList
              text={
                filtered
                  ? "No threads match the filter."
                  : "Nothing yet. Start a new thread to ask anything, or to plan some work."
              }
            />
          ) : null)}
        {tasks.length > 0 && (
          <Section title="Tasks">
            {tasks.map((group) => (
              <Group
                key={group.id}
                collapsed={collapsed.has(group.id)}
                onToggle={() => collapsed.toggle(group.id)}
                {...rowsProps(group)}
              />
            ))}
          </Section>
        )}
        {chats && (
          <Section title="Chats">
            <GroupRows collapsed={false} {...rowsProps(chats)} />
          </Section>
        )}
        {done && (
          // Pinned to the foot of the list while there's room; once the list scrolls, it follows the chats.
          <div className="mt-auto pt-4">
            <Group
              collapsed={collapsed.has(done.id)}
              onToggle={() => collapsed.toggle(done.id)}
              {...rowsProps(done)}
            />
          </div>
        )}
      </div>
    </nav>
  );
}

function HeaderButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon-sm"
      className={cn(
        "relative shrink-0 text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-foreground data-popup-open:bg-sidebar-selected data-popup-open:text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}

const ALL = "all";

/** Narrows the lists, and the board, to one project, or to what needs the person. */
function FilterMenu({
  projects: projectList,
  filter,
  waiting,
  triggerRef,
}: {
  projects: Project[];
  filter: ListFilter;
  /** How many threads need the person, in the project shown. */
  waiting: number;
  triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  const on = filter.projectId !== undefined || filter.needsYou;
  return (
    <DropdownMenu>
      <Tip label={on ? "Filter (on)" : "Filter"}>
        <DropdownMenuTrigger
          render={
            <HeaderButton
              ref={triggerRef}
              aria-label={on ? "Filter, on" : "Filter"}
              className={cn(on && "text-sidebar-foreground")}
            />
          }
        >
          <HugeiconsIcon icon={FilterIcon} strokeWidth={1.8} />
          {on && (
            <span
              aria-hidden
              className="absolute top-1 right-1 size-1.75 rounded-full bg-sidebar-primary ring-2 ring-sidebar"
            />
          )}
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Project</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={filter.projectId ?? ALL}
            onValueChange={(value: string) =>
              setListFilter({ projectId: value === ALL ? undefined : value })
            }
          >
            <DropdownMenuRadioItem value={ALL}>All projects</DropdownMenuRadioItem>
            {projectList.map((entry) => (
              <DropdownMenuRadioItem key={entry.id} value={entry.id} title={entry.path}>
                <span className="truncate">{entry.name}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show only</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={filter.needsYou}
            onCheckedChange={(checked) => setListFilter({ needsYou: checked })}
          >
            Needs you
            {waiting > 0 && <WaitingCount count={waiting} className="ml-auto" />}
          </DropdownMenuCheckboxItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function WaitingCount({ count, className }: { count: number; className?: string }) {
  return (
    <span
      className={cn(
        "rounded-full bg-amber-500 px-1.25 text-[10.5px] leading-4 font-semibold text-white tabular-nums",
        className,
      )}
    >
      {count}
    </span>
  );
}

/**
 * The filters on, each a chip with its own way off, so the lists never hide threads without
 * saying so. The project's chip also holds what can be done to the project.
 */
function ActiveFilters({
  project,
  needsYou: onlyNeedsYou,
  openId,
  onCleared,
}: {
  project: Project | undefined;
  needsYou: boolean;
  openId: string | undefined;
  onCleared: () => void;
}) {
  const [removing, setRemoving] = useState<Project>();
  const clear = (change: Partial<ListFilter>) => {
    setListFilter(change);
    onCleared();
  };

  return (
    <>
      {(project || onlyNeedsYou) && (
        <div className="flex flex-wrap gap-1 pt-1.5">
          {project && (
            <FilterChip
              clear={`Show all projects, not only ${project.name}`}
              onClear={() => clear({ projectId: undefined })}
            >
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`${project.name}: the project shown`}
                      title={project.path}
                      className="flex h-full min-w-0 items-center gap-1 rounded-full pr-0.5 pl-2 outline-none hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                    />
                  }
                >
                  <HugeiconsIcon
                    icon={Folder01Icon}
                    strokeWidth={1.8}
                    className="size-3.5 shrink-0"
                  />
                  <span className="truncate">{project.name}</span>
                  <HugeiconsIcon
                    icon={ArrowDown01Icon}
                    strokeWidth={2}
                    className="size-3 shrink-0"
                  />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuItem onClick={() => openInEditor(project.id)}>
                    <HugeiconsIcon icon={VisualStudioCodeIcon} strokeWidth={1.8} />
                    Open in VS Code
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setRemoving(project)}>
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
                    Remove {project.name}…
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </FilterChip>
          )}
          {onlyNeedsYou && (
            <FilterChip
              clear="Show every thread, not only those that need you"
              onClear={() => clear({ needsYou: false })}
            >
              <span className="flex items-center gap-1.5 pl-2">
                <span aria-hidden className="size-2 rounded-full bg-amber-500" />
                Needs you
              </span>
            </FilterChip>
          )}
        </div>
      )}

      {/* Outside the chips, so it stays to close once the filter it came from is gone. */}
      <Confirm
        open={removing !== undefined}
        onOpenChange={(open) => !open && setRemoving(undefined)}
        title={`Remove ${removing?.name ?? "the project"}?`}
        action="Remove project"
        onConfirm={() => {
          if (!removing) return;
          const open = openId ? threads.get(openId) : undefined;
          if (open?.projectId === removing.id) openDraft();
          setListFilter({ projectId: undefined });
          removeProject(removing.id);
        }}
      >
        Its threads and tasks are deleted from dodocode. The folder and its files stay as they are.
      </Confirm>
    </>
  );
}

function FilterChip({
  clear,
  onClear,
  children,
}: {
  /** What clearing it does, for its button. */
  clear: string;
  onClear: () => void;
  children: ReactNode;
}) {
  return (
    <span className="flex h-6 max-w-full min-w-0 items-center rounded-full bg-sidebar-selected text-[12px] text-sidebar-foreground shadow-xs ring-1 ring-sidebar-border">
      {children}
      <Tip label={clear}>
        <button
          type="button"
          aria-label={clear}
          onClick={onClear}
          className="mr-0.5 grid size-5 shrink-0 place-items-center rounded-full text-sidebar-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
        >
          <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} className="size-3" />
        </button>
      </Tip>
    </span>
  );
}

function EmptyList({ text }: { text: string }) {
  return <p className="px-2 pt-3 pb-1.5 text-[12.5px] text-sidebar-muted-foreground">{text}</p>;
}

/** Tasks, or chats: a heading that names the kind, with nothing to click. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-px pt-4">
      <h2 className="px-2 pb-1 text-[11px] font-semibold tracking-[0.06em] text-sidebar-muted-foreground uppercase">
        {title}
      </h2>
      {children}
    </section>
  );
}

interface GroupRowsProps {
  group: SidebarGroup;
  collapsed: boolean;
  expanded: boolean;
  onExpand: (on: boolean) => void;
  openId: string | undefined;
  /** The top thread the open thread belongs to: itself, or the one whose subagent is open. */
  openTopId: string | undefined;
  now: number;
}

/** A stage of the tasks, which folds shut from its heading. */
function Group({ onToggle, ...props }: GroupRowsProps & { onToggle: () => void }) {
  const { group, collapsed } = props;
  const label = GROUP_LABEL[group.id];
  return (
    <section aria-label={label} className="flex flex-col gap-px pb-1">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="group/heading flex h-7 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12px] text-sidebar-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <StatusGlyph status={group.id} />
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{group.total}</span>
        {/* Always shown, so a heading that folds never looks like one that starts something. */}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          aria-hidden
          className={cn(
            "ml-auto size-3.5 opacity-60 transition group-hover/heading:opacity-100",
            collapsed && "-rotate-90",
          )}
        />
      </button>
      <GroupRows {...props} />
    </section>
  );
}

function GroupRows({
  group,
  collapsed,
  expanded,
  onExpand,
  openId,
  openTopId,
  now,
}: GroupRowsProps) {
  // A folded group still shows the open thread, so the list never loses where you are.
  const rows = collapsed ? group.rows.filter((row) => row.thread.id === openTopId) : group.rows;
  return (
    <>
      {rows.map(({ thread, status }) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          status={status}
          open={thread.id === openId ? "page" : thread.id === openTopId ? "within" : undefined}
          now={now}
        />
      ))}
      {!collapsed && group.hidden > 0 && (
        <MoreButton onClick={() => onExpand(true)}>Show {group.hidden} more</MoreButton>
      )}
      {!collapsed && expanded && group.total > LIST_LIMIT && (
        <MoreButton onClick={() => onExpand(false)}>Show fewer</MoreButton>
      )}
    </>
  );
}

function MoreButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="h-6.5 rounded-[7px] pl-7.5 text-left text-[12px] text-sidebar-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
    >
      {children}
    </button>
  );
}

/**
 * One thread, on one line: what needs the person or runs, the title, and how long since anything
 * happened. The rest of what there is to know about it is in its details, beside it once open.
 */
function ThreadRow({
  thread,
  status,
  open,
  now,
}: {
  thread: Thread;
  /** What its mark shows: its own status, or a subagent's. */
  status: ThreadStatus;
  /** `page`: the thread is open. `within`: one of its subagents or reviews is. */
  open: "page" | "within" | undefined;
  now: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const settleable = thread.task !== undefined && thread.task.status !== "done";

  if (renaming) {
    return (
      <RenameField
        title={thread.title}
        onDone={(title) => {
          setRenaming(false);
          if (title && title !== thread.title) renameThread(thread.id, title);
        }}
      />
    );
  }

  return (
    <div className="group/thread relative">
      <button
        type="button"
        aria-current={open === "page" ? "page" : open === "within" ? "true" : undefined}
        onClick={() => openThread(thread.id)}
        onDoubleClick={() => setRenaming(true)}
        className={cn(
          "flex h-7.5 w-full items-center gap-2 rounded-[7px] pr-2 pl-7.5 text-left whitespace-nowrap transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          open && "bg-sidebar-selected hover:bg-sidebar-selected",
        )}
      >
        {/* In the row's left margin, so the title stays put. */}
        <span className="-ml-5.5 grid size-3.5 shrink-0 place-items-center">
          <Attention
            thread={thread}
            status={status}
            className="text-sidebar-muted-foreground"
            idle={
              thread.pinned ? (
                <HugeiconsIcon
                  icon={PinIcon}
                  strokeWidth={1.8}
                  aria-label="Pinned"
                  className="size-3 text-sidebar-muted-foreground"
                />
              ) : null
            }
          />
        </span>
        <span className="min-w-0 flex-1 truncate">
          {thread.title}
          {thread.archived && <span className="text-sidebar-muted-foreground"> · Archived</span>}
        </span>
        <span className="shrink-0 text-[11.5px] text-sidebar-muted-foreground tabular-nums group-focus-within/thread:invisible group-hover/thread:invisible group-has-data-popup-open/thread:invisible">
          {ago(thread.activityAt, now)}
        </span>
      </button>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center opacity-0 transition-opacity group-focus-within/thread:opacity-100 group-hover/thread:opacity-100 has-data-popup-open:opacity-100">
        {settleable && (
          <Tip label="Mark done" side="right">
            <RowButton
              aria-label={`Mark ${thread.title} done`}
              onClick={() => void moveTask(thread, "done", true)}
            >
              <HugeiconsIcon icon={Tick02Icon} strokeWidth={2} />
            </RowButton>
          </Tip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger render={<RowButton aria-label={`${thread.title} actions`} />}>
            <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="right" className="min-w-44">
            {(thread.task || thread.projectId) && (
              <>
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <StatusGlyph status={thread.task?.status ?? "todo"} />
                    {thread.task ? "Move to" : "Make it a task"}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="min-w-40">
                    <MoveItems thread={thread} />
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
                <DropdownMenuSeparator />
              </>
            )}
            <DropdownMenuItem onClick={() => setPinned(thread.id, !thread.pinned)}>
              <HugeiconsIcon icon={thread.pinned ? PinOffIcon : PinIcon} strokeWidth={1.8} />
              {thread.pinned ? "Unpin" : "Pin"}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={1.8} />
              Rename
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => setArchived(thread.id, !thread.archived)}>
              <HugeiconsIcon
                icon={thread.archived ? ArchiveArrowUpIcon : Archive02Icon}
                strokeWidth={1.8}
              />
              {thread.archived ? "Unarchive" : "Archive"}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
              <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <Confirm
        open={deleting}
        onOpenChange={setDeleting}
        title={`Delete ${thread.title}?`}
        action="Delete thread"
        onConfirm={() => {
          // Its subagents go with it, so leave one of theirs that is open too.
          if (open) openDraft(thread.projectId);
          deleteThread(thread.id);
        }}
      >
        Its messages and the threads of its subagents go too. This can't be undone.
        {thread.worktree && thread.worktree.mergedAt === undefined && (
          <>
            {" "}
            Its worktree goes as well. What it changed stays, committed on the branch{" "}
            <span className="font-mono text-foreground">{thread.worktree.branch}</span>.
          </>
        )}
      </Confirm>
    </div>
  );
}

function RenameField({
  title,
  onDone,
}: {
  title: string;
  onDone: (title: string | undefined) => void;
}) {
  return (
    <input
      aria-label="Thread title"
      // oxlint-disable-next-line jsx-a11y/no-autofocus -- the person asked to rename it
      autoFocus
      defaultValue={title}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={(event) => onDone(event.currentTarget.value.trim())}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDone(event.currentTarget.value.trim());
        if (event.key === "Escape") onDone(undefined);
      }}
      className="h-7.5 w-full rounded-[7px] bg-background pr-2 pl-7.5 text-foreground ring-2 ring-sidebar-ring outline-none"
    />
  );
}

export function Confirm({
  open,
  onOpenChange,
  title,
  action,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  action: string;
  onConfirm: () => void;
  children: ReactNode;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{children}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <Button
            variant="destructive"
            onClick={() => {
              onOpenChange(false);
              onConfirm();
            }}
          >
            {action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function RowButton({ className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      className={cn(
        "text-sidebar-muted-foreground hover:bg-sidebar-selected hover:text-sidebar-foreground data-popup-open:bg-sidebar-selected data-popup-open:text-sidebar-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function SidebarRow({
  icon,
  className,
  children,
  ...props
}: ComponentProps<"button"> & { icon: typeof Add01Icon }) {
  return (
    <button
      type="button"
      className={cn(
        "flex h-7.5 w-full shrink-0 items-center gap-2 rounded-[7px] px-2 text-left whitespace-nowrap transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
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

/** Which groups are folded shut, kept between launches. */
function useCollapsedGroups() {
  const [ids, setIds] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem(COLLAPSED_KEY);
      return new Set(saved ? (JSON.parse(saved) as string[]) : COLLAPSED_AT_FIRST);
    } catch {
      return new Set(COLLAPSED_AT_FIRST);
    }
  });
  return {
    has: (id: string) => ids.has(id),
    toggle: (id: string) =>
      setIds((current) => {
        const next = new Set(current);
        if (!next.delete(id)) next.add(id);
        try {
          localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
        } catch {
          // Folding still works; it just won't be kept.
        }
        return next;
      }),
  };
}
