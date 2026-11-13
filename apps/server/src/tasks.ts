// The rules for chats and tasks: when a chat becomes a task, how a task moves between the board's
// columns, and how tasks fold together and come apart. Each rule takes a thread and gives back the
// changed copy, or throws with words the person can read.

import type { OutgoingMessage, TaskItem, TaskStatus, Thread } from "@dodocode/protocol";

import { newId, titleFrom } from "./util";

/** The task item a message makes: its first line as the title, and all of it when there's more. */
export function itemFrom(message: OutgoingMessage): TaskItem {
  const text = message.text.trim();
  if (!text) throw new Error("Write what the task is for.");
  const title = titleFrom(text);
  return {
    id: newId(),
    title,
    ...(text === title ? {} : { body: text }),
    ...(message.images.length > 0 ? { images: message.images } : {}),
  };
}

/** A task that holds one item, not started: in To do, ready to start, or an idea in the backlog. */
export function todoTask(
  base: Thread,
  item: TaskItem,
  now: number,
  status: "todo" | "backlog" = "todo",
): Thread {
  return { ...base, title: item.title, task: { status, covers: [item], movedAt: now } };
}

/**
 * The thread moved to `status`, or made a chat again by `null`; a chat made again stays one.
 * Only what nobody started goes to the backlog: work under way is planned already.
 */
export function moved(thread: Thread, status: TaskStatus | null, now: number): Thread {
  if (status === null) {
    if (!thread.task) return thread;
    if (thread.startedAt === undefined) {
      throw new Error("This task hasn't started, so there is no chat to go back to.");
    }
    return { ...thread, task: undefined, keepChat: true, updatedAt: now };
  }
  if (thread.kind === "review") throw new Error("A review belongs to its task. It can't be one.");
  if (thread.kind !== "main") throw new Error("A subagent's thread can't be a task.");
  if (!thread.projectId) throw new Error("Only a thread in a project can be a task.");
  if (thread.task?.status === status) return thread;
  if (status === "backlog" && thread.startedAt !== undefined) {
    throw new Error("It has started, so it can't go back to the backlog.");
  }
  const { suggestedBy, autoReviewed } = thread.task ?? {};
  return {
    ...thread,
    task: {
      covers: thread.task?.covers ?? [],
      status,
      movedAt: now,
      ...(suggestedBy ? { suggestedBy } : {}),
      ...(autoReviewed ? { autoReviewed } : {}),
    },
    updatedAt: now,
  };
}

/**
 * The task back in In progress because its agent changed files while it was in review, or
 * nothing when it isn't in review. The person can move it back.
 */
export function reopened(thread: Thread, now: number): Thread | undefined {
  if (thread.task?.status !== "review") return undefined;
  const next = moved(thread, "progress", now);
  return { ...next, task: { ...next.task!, reopened: true } };
}

/**
 * The task a chat becomes once its agent changes files, or nothing when it stays a chat: it is
 * a task already, the person kept it a chat, or it has no project to change.
 */
export function promoted(thread: Thread, now: number): Thread | undefined {
  if (thread.task || thread.keepChat || !thread.projectId || thread.kind !== "main") {
    return undefined;
  }
  return {
    ...thread,
    task: { status: "progress", covers: [], movedAt: now, promoted: true },
    updatedAt: now,
  };
}

/** The thread as a turn starts in it: a task waiting in To do or the backlog moves to In progress. */
export function started(thread: Thread, now: number): Thread {
  let next = thread.startedAt === undefined ? { ...thread, startedAt: now } : thread;
  if (next.task?.status === "todo" || next.task?.status === "backlog") {
    next = {
      ...next,
      task: { ...next.task, status: "progress", movedAt: now, promoted: undefined },
    };
  }
  return next;
}

/**
 * `target` with what `sources` cover added to it, and the items that were added. Only tasks
 * nobody has started fold in, from the same project, and not into a task that is done.
 */
export function merged(
  target: Thread,
  sources: readonly Thread[],
  now: number,
): { thread: Thread; added: TaskItem[] } {
  if (!target.task) throw new Error("Only a task can take on more. Make this chat a task first.");
  if (target.task.status === "done") throw new Error("This task is done. Reopen it first.");
  for (const source of sources) {
    if (source.id === target.id) throw new Error("A task can't fold into itself.");
    if (!source.task || source.startedAt !== undefined) {
      throw new Error(`“${source.title}” has started, so it can't fold into another task.`);
    }
    if (source.projectId !== target.projectId) {
      throw new Error(`“${source.title}” is in another project.`);
    }
  }
  const added = sources.flatMap((source) =>
    source.task!.covers.length > 0 ? source.task!.covers : [{ id: newId(), title: source.title }],
  );
  return {
    thread: {
      ...target,
      task: { ...target.task, covers: [...target.task.covers, ...added] },
      updatedAt: now,
    },
    added,
  };
}

/**
 * The task without one of its items, and that item. A task nobody has started keeps at least one
 * item, and takes its title from the first one left.
 */
export function split(
  thread: Thread,
  itemId: string,
  now: number,
): { thread: Thread; item: TaskItem } {
  const task = thread.task;
  const item = task?.covers.find((entry) => entry.id === itemId);
  if (!task || !item) throw new Error("That item is no longer on this task.");
  const covers = task.covers.filter((entry) => entry.id !== itemId);
  const unstarted = thread.startedAt === undefined;
  if (unstarted && covers.length === 0) throw new Error("It's the only thing this task covers.");
  return {
    thread: {
      ...thread,
      title: unstarted ? covers[0]!.title : thread.title,
      task: { ...task, covers },
      updatedAt: now,
    },
    item,
  };
}
