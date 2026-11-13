// How the sidebar and the board sort the threads: chats and tasks, by where each task is, with
// what needs the person first. Both are views of one list, so they share these rules.

import { TASK_STATUS_LABEL, unstarted, type TaskStatus, type Thread } from "@dodocode/protocol";

/** A group in the sidebar: a column of the board, or the chats, which are not on the board. */
export type GroupId = TaskStatus | "chats";

/**
 * The sidebar's groups, in order: the tasks, from under way to done, then the chats. Ideas in the
 * backlog aren't planned, so they stay on the board.
 */
export const GROUPS: readonly GroupId[] = ["progress", "review", "todo", "done", "chats"];

/** The board's columns, in order. The backlog shows left of them, when it is open. */
export const COLUMNS: readonly TaskStatus[] = ["todo", "progress", "review", "done"];

export const GROUP_LABEL: Record<GroupId, string> = { ...TASK_STATUS_LABEL, chats: "Chats" };

/** A chat left this long drops out of the sidebar, behind "Show more". Search still finds it. */
export const CHAT_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function groupOf(thread: Thread): GroupId {
  return thread.task?.status ?? "chats";
}

/** Waiting for an answer, or stopped by an error. */
export function needsYou(thread: Thread): boolean {
  return thread.status === "waiting" || thread.status === "error";
}

/** What the lists show and hide. */
export interface ListFilter {
  /** Only this project's threads. Threads without a project show only under all projects. */
  projectId?: string;
  /** Only threads that wait for the person, or one of whose subagents does. */
  needsYou: boolean;
}

export interface SidebarRow {
  thread: Thread;
  /** A subagent's thread, shown under the thread that started it. */
  nested: boolean;
}

export interface SidebarGroup {
  id: GroupId;
  rows: SidebarRow[];
  /** Top threads the group holds, shown or not. */
  total: number;
  /** Top threads behind "Show more". */
  hidden: number;
}

/**
 * The sidebar's groups, each holding its top threads with their subagents under them. A group
 * shows `limit` top threads, and the open one even past that; a chat left for a while waits
 * behind "Show more". Archived threads show only while open, and empty groups not at all.
 */
export function sidebarGroups(
  threads: readonly Thread[],
  options: {
    openId?: string;
    filter: ListFilter;
    /** Groups showing everything they hold. */
    expanded?: ReadonlySet<GroupId>;
    limit: number;
    now: number;
  },
): SidebarGroup[] {
  const { openId, filter, expanded, limit, now } = options;
  const tree = threadTree(threads);
  const open = openId ? tree.byId.get(openId) : undefined;
  const openRoot = open ? tree.rootOf(open) : undefined;

  const byGroup = new Map<GroupId, Thread[]>();
  for (const top of tree.tops) {
    if (top.archived && top !== openRoot) continue;
    if (!matches(top, tree.children.get(top.id) ?? [], filter) && top !== openRoot) continue;
    const id = groupOf(top);
    const list = byGroup.get(id) ?? [];
    list.push(top);
    byGroup.set(id, list);
  }

  const groups: SidebarGroup[] = [];
  for (const id of GROUPS) {
    const tops = (byGroup.get(id) ?? []).toSorted(id === "done" ? byMoved : byAttention);
    if (tops.length === 0) continue;
    const all = expanded?.has(id) ?? false;
    const recent = (thread: Thread) =>
      id !== "chats" || thread.pinned || now - thread.activityAt < CHAT_AGE_MS;
    const shown = all ? tops : tops.filter(recent).slice(0, limit);
    if (openRoot && tops.includes(openRoot) && !shown.includes(openRoot)) shown.push(openRoot);

    const rows: SidebarRow[] = [];
    for (const top of shown) {
      rows.push({ thread: top, nested: false });
      for (const child of tree.children.get(top.id) ?? []) {
        const active = child.status === "running" || child.status === "waiting";
        if (top === openRoot || active) rows.push({ thread: child, nested: true });
      }
    }
    groups.push({ id, rows, total: tops.length, hidden: tops.length - shown.length });
  }
  return groups;
}

/** The board's columns, the backlog among them, and the ideas set aside as not worth doing. */
export interface BoardColumns extends Record<TaskStatus, Thread[]> {
  /** Ideas in the backlog marked "Not doing": archived, and kept in case they come back. */
  notDoing: Thread[];
}

/** The board's columns: the tasks that pass the filter, in each column's order. */
export function boardColumns(threads: readonly Thread[], filter: ListFilter): BoardColumns {
  const tree = threadTree(threads);
  const columns: BoardColumns = {
    backlog: [],
    todo: [],
    progress: [],
    review: [],
    done: [],
    notDoing: [],
  };
  for (const top of tree.tops) {
    if (!top.task) continue;
    if (!matches(top, tree.children.get(top.id) ?? [], filter)) continue;
    if (!top.archived) columns[top.task.status].push(top);
    else if (top.task.status === "backlog") columns.notDoing.push(top);
  }
  for (const status of ["backlog", ...COLUMNS] as const) {
    columns[status].sort(status === "done" ? byMoved : byAttention);
  }
  columns.notDoing.sort(byUpdated);
  return columns;
}

/** What dropping a card on the board does. */
export type Drop =
  | { kind: "none" }
  /** A task nobody started, dropped on In progress: its first turn starts. */
  | { kind: "start" }
  | { kind: "move"; status: TaskStatus }
  /** A task nobody started, dropped on another task: it becomes part of that one. */
  | { kind: "merge"; into: Thread };

/** What a card dropped on a column, or on another card, does. */
export function dropOf(card: Thread, target: TaskStatus | Thread): Drop {
  if (typeof target !== "string") {
    if (canMerge(card, target)) return { kind: "merge", into: target };
    return target.task ? dropOf(card, target.task.status) : { kind: "none" };
  }
  if (card.task?.status === target) return { kind: "none" };
  // Work under way is planned already.
  if (target === "backlog" && !unstarted(card)) return { kind: "none" };
  if (target === "progress" && unstarted(card)) return { kind: "start" };
  return { kind: "move", status: target };
}

/**
 * True when `card` can fold into `target`: only a task nobody started, into one not done. Only
 * ideas fold into an idea, so planned work doesn't drop back into the backlog that way.
 */
export function canMerge(card: Thread, target: Thread): boolean {
  return (
    card.id !== target.id &&
    unstarted(card) &&
    target.task !== undefined &&
    target.task.status !== "done" &&
    (target.task.status !== "backlog" || card.task?.status === "backlog") &&
    card.projectId === target.projectId
  );
}

/** A task with work that can be reviewed: started, not done, and not merged. */
export function reviewable(thread: Thread): boolean {
  return (
    thread.kind === "main" &&
    thread.projectId !== undefined &&
    thread.task !== undefined &&
    thread.task.status !== "done" &&
    !unstarted(thread) &&
    thread.worktree?.mergedAt === undefined
  );
}

// Helpers

/** Pinned first, then what waits for the person, then the newest activity. */
function byAttention(a: Thread, b: Thread): number {
  return (
    Number(b.pinned ?? false) - Number(a.pinned ?? false) ||
    Number(needsYou(b)) - Number(needsYou(a)) ||
    b.activityAt - a.activityAt
  );
}

/** The latest changed first. */
function byUpdated(a: Thread, b: Thread): number {
  return b.updatedAt - a.updatedAt;
}

/** Done: the latest finished first. */
function byMoved(a: Thread, b: Thread): number {
  return (b.task?.movedAt ?? b.activityAt) - (a.task?.movedAt ?? a.activityAt);
}

function matches(top: Thread, children: readonly Thread[], filter: ListFilter): boolean {
  if (filter.projectId && top.projectId !== filter.projectId) return false;
  if (filter.needsYou && !needsYou(top) && !children.some(needsYou)) return false;
  return true;
}

/** The threads as top threads, and the subagents of each, by its top thread. */
function threadTree(threads: readonly Thread[]) {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const rootOf = (thread: Thread): Thread => {
    let current = thread;
    const seen = new Set<string>();
    while (current.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      const parent = byId.get(current.parentId);
      if (!parent) break;
      current = parent;
    }
    return current;
  };
  const tops: Thread[] = [];
  const children = new Map<string, Thread[]>();
  for (const thread of threads) {
    const root = rootOf(thread);
    if (root === thread) {
      tops.push(thread);
      continue;
    }
    const list = children.get(root.id) ?? [];
    list.push(thread);
    children.set(root.id, list);
  }
  return { byId, rootOf, tops, children };
}
