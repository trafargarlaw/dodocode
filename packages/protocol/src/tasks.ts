// What the server and the window both work out about tasks.

import type { TaskItem, TaskStatus, Thread } from "./domain";

/** The board's name for each column. */
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  backlog: "Backlog",
  todo: "To do",
  progress: "In progress",
  review: "In review",
  done: "Done",
};

/** The words of a task item: all of it when there is more than the title. */
export function itemText(item: TaskItem): string {
  return item.body ?? item.title;
}

/** The first message of a task that has not started: what it covers, in the person's words. */
export function taskPrompt(covers: readonly TaskItem[]): string {
  if (covers.length === 1) return itemText(covers[0]!);
  return [
    "Work on these together, as one piece of work:",
    ...covers.map((item, index) => `${index + 1}. ${indent(itemText(item))}`),
  ].join("\n\n");
}

/** The message that hands a started task more to do. */
export function addedPrompt(added: readonly TaskItem[]): string {
  if (added.length === 1)
    return `Also do this, as part of the same work:\n\n${itemText(added[0]!)}`;
  return [
    "Also do these, as part of the same work:",
    ...added.map((item, index) => `${index + 1}. ${indent(itemText(item))}`),
  ].join("\n\n");
}

/** True for a task nobody has started: it has no messages, only what it covers. */
export function unstarted(thread: Thread): boolean {
  return thread.task !== undefined && thread.startedAt === undefined;
}

function indent(text: string): string {
  return text.replaceAll("\n", "\n   ");
}
