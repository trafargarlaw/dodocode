import { useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { useAppHotkeys } from "@tanstack/react-hotkeys";
import { useLiveQuery } from "@tanstack/react-db";
import type { Project, Thread } from "@dodocode/protocol";
import {
  Add01Icon,
  Archive02Icon,
  ArchiveArrowUpIcon,
  ArrowDown01Icon,
  ArrowRight01Icon,
  Delete02Icon,
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
  DropdownMenuContent,
  DropdownMenuItem,
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
import { setListFilter, useListFilter } from "./list-filter";
import {
  addProject,
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
import { GROUP_LABEL, needsYou, sidebarGroups, type GroupId, type SidebarGroup } from "./task-list";
import { Attention, MoveItems, StatusGlyph } from "./task-ui";
import { ago, useNow } from "./time";
import { openBoard, openDraft, openThread, useView } from "./view";

/** How many threads a group lists before "Show more". */
const LIST_LIMIT = 8;
const COLLAPSED_KEY = "dodocode:collapsed-groups";
/** Done starts folded: what's finished matters less than what isn't. */
const COLLAPSED_AT_FIRST: GroupId[] = ["done"];

export function Sidebar({
  newThread,
  onNewThread,
}: {
  newThread: Ref<HTMLButtonElement>;
  onNewThread: () => void;
}) {
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

  const groups = sidebarGroups(threadList, {
    openId,
    filter,
    expanded,
    limit: LIST_LIMIT,
    now,
  });
  const names = new Map(projectList.map((project) => [project.id, project.name]));
  // A row names its project only while the list mixes them.
  const mixed = !filter.projectId && new Set(threadList.map((thread) => thread.projectId)).size > 1;
  const waiting = threadList.filter(
    (thread) =>
      needsYou(thread) &&
      !thread.archived &&
      (!filter.projectId || thread.projectId === filter.projectId),
  ).length;

  const expand = (id: GroupId, on: boolean) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  return (
    <nav aria-label="Threads" className="flex h-full min-h-0 flex-col px-2.5 pt-1.5 pb-2.5">
      <SidebarRow
        ref={newThread}
        icon={PencilEdit02Icon}
        className={cn("relative font-medium", view.kind === "draft" && "bg-sidebar-selected")}
        onClick={onNewThread}
      >
        <span className="flex-1">New thread</span>
        <HeldKeys hotkey={hotkeys["thread.new"]} className="right-1.5" />
      </SidebarRow>
      <SidebarRow
        icon={KanbanIcon}
        aria-current={view.kind === "board" ? "page" : undefined}
        className={cn(view.kind === "board" && "bg-sidebar-selected hover:bg-sidebar-selected")}
        onClick={openBoard}
      >
        <span className="flex-1">Board</span>
      </SidebarRow>

      <FilterBar projects={projectList} projectId={filter.projectId} openId={openId}>
        <button
          type="button"
          aria-pressed={filter.needsYou}
          onClick={() => setListFilter({ needsYou: !filter.needsYou })}
          className={cn(
            CHIP,
            "shrink-0",
            filter.needsYou && "bg-sidebar-selected text-sidebar-foreground",
          )}
        >
          Needs you
          {waiting > 0 && (
            <span className="rounded-full bg-amber-500 px-1.25 text-[10.5px] leading-4 font-semibold text-white tabular-nums">
              {waiting}
            </span>
          )}
        </button>
      </FilterBar>

      <div className="-mx-2.5 flex min-h-0 flex-1 flex-col gap-px overflow-y-auto px-2.5">
        {isReady &&
          (filter.needsYou && waiting === 0 ? (
            // The open thread still shows, so this says why nothing else does.
            <EmptyList text="Nothing needs you right now." />
          ) : groups.length === 0 ? (
            <EmptyList
              text={
                filter.needsYou || filter.projectId !== undefined
                  ? "Nothing here. Change the filter to see more."
                  : "Nothing yet. Ask anything, or add a task to To do."
              }
            />
          ) : null)}
        {groups.map((group) => (
          <Group
            key={group.id}
            group={group}
            collapsed={collapsed.has(group.id)}
            onToggle={() => collapsed.toggle(group.id)}
            expanded={expanded.has(group.id)}
            onExpand={(on) => expand(group.id, on)}
            openId={openId}
            now={now}
            projectName={(thread) =>
              mixed && thread.projectId ? names.get(thread.projectId) : undefined
            }
          />
        ))}
      </div>
    </nav>
  );
}

const CHIP =
  "flex h-6.5 min-w-0 items-center gap-1.5 rounded-[7px] px-2 text-[12px] text-sidebar-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring data-popup-open:bg-sidebar-accent data-popup-open:text-sidebar-foreground";

const ALL = "all";

/** Which project the lists show, the projects' own actions, and the other filters. */
function FilterBar({
  projects: projectList,
  projectId,
  openId,
  children,
}: {
  projects: Project[];
  projectId: string | undefined;
  openId: string | undefined;
  children: ReactNode;
}) {
  const [removing, setRemoving] = useState<Project>();
  const project = projectList.find((entry) => entry.id === projectId);

  return (
    <div className="flex items-center justify-between gap-1 pt-3 pb-1">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              aria-label={`Showing ${project?.name ?? "all projects"}`}
              className={CHIP}
            />
          }
        >
          <HugeiconsIcon icon={Folder01Icon} strokeWidth={1.8} className="size-3.5 shrink-0" />
          <span className="truncate">{project?.name ?? "All projects"}</span>
          <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} className="size-3 shrink-0" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-52">
          <DropdownMenuRadioGroup
            value={projectId ?? ALL}
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
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() =>
              void addProject().then((added) => added && setListFilter({ projectId: added.id }))
            }
          >
            <HugeiconsIcon icon={FolderAddIcon} strokeWidth={1.8} />
            Add a project…
          </DropdownMenuItem>
          {project && (
            <>
              <DropdownMenuItem onClick={() => openInEditor(project.id)}>
                <HugeiconsIcon icon={VisualStudioCodeIcon} strokeWidth={1.8} />
                Open {project.name} in VS Code
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={() => setRemoving(project)}>
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={1.8} />
                Remove {project.name}…
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {children}

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
    </div>
  );
}

function EmptyList({ text }: { text: string }) {
  return <p className="px-2 py-1.5 text-[12.5px] text-sidebar-muted-foreground">{text}</p>;
}

function Group({
  group,
  collapsed,
  onToggle,
  expanded,
  onExpand,
  openId,
  now,
  projectName,
}: {
  group: SidebarGroup;
  collapsed: boolean;
  onToggle: () => void;
  expanded: boolean;
  onExpand: (on: boolean) => void;
  openId: string | undefined;
  now: number;
  projectName: (thread: Thread) => string | undefined;
}) {
  const label = GROUP_LABEL[group.id];
  // A folded group still shows the open thread, so the list never loses where you are.
  const rows = collapsed ? group.rows.filter((row) => row.thread.id === openId) : group.rows;

  return (
    <section aria-label={label} className="flex flex-col gap-px pb-1.5">
      <button
        type="button"
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="group/heading flex h-7 w-full items-center gap-2 rounded-[7px] px-2 text-left text-[12px] text-sidebar-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
      >
        <span className="relative grid size-3.75 shrink-0 place-items-center">
          <StatusGlyph
            status={group.id}
            className="transition-opacity group-hover/heading:opacity-0"
          />
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            strokeWidth={2}
            className={cn(
              "absolute size-3.5 opacity-0 transition group-hover/heading:opacity-100",
              !collapsed && "rotate-90",
            )}
          />
        </span>
        <span className="font-medium">{label}</span>
        <span className="tabular-nums">{group.total}</span>
      </button>

      {rows.map(({ thread, nested }) => (
        <ThreadRow
          key={thread.id}
          thread={thread}
          nested={nested}
          open={thread.id === openId}
          now={now}
          project={nested ? undefined : projectName(thread)}
        />
      ))}
      {!collapsed && group.hidden > 0 && (
        <MoreButton onClick={() => onExpand(true)}>Show {group.hidden} more</MoreButton>
      )}
      {!collapsed && expanded && group.total > LIST_LIMIT && (
        <MoreButton onClick={() => onExpand(false)}>Show fewer</MoreButton>
      )}
    </section>
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

function ThreadRow({
  thread,
  nested,
  open,
  now,
  project,
}: {
  thread: Thread;
  nested: boolean;
  open: boolean;
  now: number;
  /** The project's name, when the list mixes projects. */
  project: string | undefined;
}) {
  const [renaming, setRenaming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const settleable = !nested && thread.task !== undefined && thread.task.status !== "done";

  if (renaming) {
    return (
      <RenameField
        title={thread.title}
        nested={nested}
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
        aria-current={open ? "page" : undefined}
        onClick={() => openThread(thread.id)}
        onDoubleClick={() => setRenaming(true)}
        className={cn(
          "flex h-7.5 w-full items-center gap-2 rounded-[7px] pr-2 text-left whitespace-nowrap transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring",
          nested ? "pl-11" : "pl-7.5",
          open && "bg-sidebar-selected hover:bg-sidebar-selected",
        )}
      >
        {/* In the row's left margin, so the title stays put. */}
        <span className="-ml-5.5 grid size-3.5 shrink-0 place-items-center">
          <Attention
            thread={thread}
            className="text-sidebar-muted-foreground"
            idle={
              thread.pinned && !nested ? (
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
        <span className={cn("min-w-0 flex-1 truncate", nested && "text-sidebar-muted-foreground")}>
          {thread.title}
          {thread.archived && <span className="text-sidebar-muted-foreground"> · Archived</span>}
        </span>
        {project && (
          <span className="max-w-20 shrink truncate text-[11.5px] text-sidebar-muted-foreground group-focus-within/thread:invisible group-hover/thread:invisible group-has-data-popup-open/thread:invisible">
            {project}
          </span>
        )}
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
            {!nested && (thread.task || thread.projectId) && (
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
            {!nested && (
              <DropdownMenuItem onClick={() => setPinned(thread.id, !thread.pinned)}>
                <HugeiconsIcon icon={thread.pinned ? PinOffIcon : PinIcon} strokeWidth={1.8} />
                {thread.pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onClick={() => setRenaming(true)}>
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={1.8} />
              Rename
            </DropdownMenuItem>
            {!nested && (
              <DropdownMenuItem onClick={() => setArchived(thread.id, !thread.archived)}>
                <HugeiconsIcon
                  icon={thread.archived ? ArchiveArrowUpIcon : Archive02Icon}
                  strokeWidth={1.8}
                />
                {thread.archived ? "Unarchive" : "Archive"}
              </DropdownMenuItem>
            )}
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
          if (open) openDraft(thread.projectId);
          deleteThread(thread.id);
        }}
      >
        Its messages and the threads of its subagents go too. This can't be undone.
      </Confirm>
    </div>
  );
}

function RenameField({
  title,
  nested,
  onDone,
}: {
  title: string;
  nested: boolean;
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
      className={cn(
        "h-7.5 w-full rounded-[7px] bg-background pr-2 text-foreground ring-2 ring-sidebar-ring outline-none",
        nested ? "pl-11" : "pl-7.5",
      )}
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
