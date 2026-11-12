// The window's copy of what the server keeps for the whole app: projects, threads, providers and
// settings. One snapshot fills all four, and the server's events keep them current.

import { createCollection } from "@tanstack/react-db";
import {
  taskPrompt,
  unstarted,
  type OutgoingMessage,
  type Project,
  type ProviderInfo,
  type Settings,
  type Snapshot,
  type TaskStatus,
  type Thread,
  type ThreadSettings,
} from "@dodocode/protocol";
import { toast } from "@dodocode/ui/components/toast";
import { GROUP_LABEL } from "../task-list";
import { server } from "./connection";
import { Feed, feedSync, type RowWriter } from "./sync";

/** Settings live in a collection of one row, so a live query can read them like the rest. */
export type SettingsRow = Settings & { id: "settings" };

let projectRows: RowWriter<Project, string> | undefined;
let threadRows: RowWriter<Thread, string> | undefined;
let providerRows: RowWriter<ProviderInfo, string> | undefined;
let settingsRows: RowWriter<SettingsRow, string> | undefined;

const appFeed = new Feed<Snapshot>({
  load: () => server.call("app.snapshot", {}),
  retry: true,
  apply: (event) => {
    switch (event.type) {
      case "projects":
        projectRows?.replace(event.projects);
        break;
      case "thread":
        announcePromotion(threads.get(event.thread.id), event.thread);
        threadRows?.upsert([event.thread]);
        break;
      case "thread.removed":
        threadRows?.remove(event.threadId);
        break;
      case "providers":
        providerRows?.replace(event.providers);
        break;
      case "settings":
        settingsRows?.upsert([{ ...event.settings, id: "settings" }]);
        break;
    }
  },
});

// The app's data is small and every window reads it, so it loads at once and is never dropped.
const kept = { startSync: true, gcTime: 0 } as const;

export const projects = createCollection<Project, string>({
  id: "projects",
  getKey: (project) => project.id,
  ...kept,
  sync: feedSync(
    appFeed,
    (project: Project) => project.id,
    (snapshot) => snapshot.projects,
    (writer) => (projectRows = writer),
  ),
  onDelete: async ({ transaction }) => {
    for (const mutation of transaction.mutations) {
      await server.call("project.remove", { projectId: mutation.key });
    }
  },
});

export const threads = createCollection<Thread, string>({
  id: "threads",
  getKey: (thread) => thread.id,
  ...kept,
  sync: feedSync(
    appFeed,
    (thread: Thread) => thread.id,
    (snapshot) => snapshot.threads,
    (writer) => (threadRows = writer),
  ),
  // The server sends the changed thread before it answers, so it is in the collection by the
  // time the call returns and the optimistic copy goes.
  onUpdate: async ({ transaction }) => {
    for (const mutation of transaction.mutations) {
      const { title, settings, pinned, archived } = mutation.changes;
      await server.call("thread.update", {
        threadId: mutation.key,
        title,
        settings,
        pinned,
        archived,
      });
    }
  },
  onDelete: async ({ transaction }) => {
    for (const mutation of transaction.mutations) {
      await server.call("thread.delete", { threadId: mutation.key });
    }
  },
});

export const providers = createCollection<ProviderInfo, string>({
  id: "providers",
  getKey: (provider) => provider.id,
  ...kept,
  sync: feedSync(
    appFeed,
    (provider: ProviderInfo): string => provider.id,
    (snapshot) => snapshot.providers,
    (writer) => (providerRows = writer),
  ),
});

export const settings = createCollection<SettingsRow, string>({
  id: "settings",
  getKey: (row) => row.id,
  ...kept,
  sync: feedSync(
    appFeed,
    (row: SettingsRow): string => row.id,
    (snapshot) => [{ ...snapshot.settings, id: "settings" }],
    (writer) => (settingsRows = writer),
  ),
});

// Actions

/** Shows a failed action to the person. Returns undefined, so a caller can fall through. */
export function reportError(title: string, error: unknown): undefined {
  const description = error instanceof Error ? error.message : String(error);
  toast.add({ title, description, type: "error" });
  return undefined;
}

export async function addProject(): Promise<Project | undefined> {
  const path = await window.dodocode.pickFolder();
  if (!path) return undefined;
  try {
    return await server.call("project.add", { path });
  } catch (error) {
    return reportError("Could not add the project", error);
  }
}

export function removeProject(projectId: string): void {
  const transaction = projects.delete(projectId);
  transaction
    .when("settled")
    .catch((error: unknown) => reportError("Could not remove the project", error));
}

export function openInEditor(projectId: string): void {
  server
    .call("project.openInEditor", { projectId })
    .catch((error: unknown) => reportError("Could not open VS Code", error));
}

/** Starts a chat with its first message, in a project or in a folder of its own. */
export async function createThread(
  projectId: string | undefined,
  threadSettings: ThreadSettings,
  message: OutgoingMessage,
): Promise<Thread | undefined> {
  try {
    return await server.call("thread.create", { projectId, settings: threadSettings, message });
  } catch (error) {
    return reportError("Could not start the thread", error);
  }
}

/** Puts a task in To do, without starting it. */
export async function createTask(
  projectId: string,
  message: OutgoingMessage,
  threadSettings?: ThreadSettings,
): Promise<Thread | undefined> {
  try {
    return await server.call("task.create", { projectId, message, settings: threadSettings });
  } catch (error) {
    return reportError("Could not add the task", error);
  }
}

/**
 * Moves a task to a column, makes a chat a task there, or with `null` makes a task a chat
 * again. `undoable` says so in a toast that can take it back.
 */
export async function moveTask(
  thread: Thread,
  status: TaskStatus | null,
  undoable = false,
): Promise<boolean> {
  const before = thread.task?.status ?? null;
  try {
    await server.call("task.move", { threadId: thread.id, status });
  } catch (error) {
    reportError(status ? "Could not move the task" : "Could not make it a chat", error);
    return false;
  }
  if (undoable && before !== status) {
    const title = status ? `Moved to ${GROUP_LABEL[status]}` : "Made it a chat";
    withUndo(title, thread.title, () => void moveTask(thread, before));
  }
  return true;
}

/** Puts a task in a column. One nobody started, put in In progress, starts. */
export function placeTask(thread: Thread, status: TaskStatus, undoable = false): Promise<boolean> {
  if (status === "progress" && unstarted(thread)) return startTask(thread);
  return moveTask(thread, status, undoable);
}

/** Starts a task in To do: the agent gets what it covers, and anything the person added. */
export async function startTask(thread: Thread, extra?: OutgoingMessage): Promise<boolean> {
  const covers = thread.task?.covers ?? [];
  const brief = covers.length > 0 ? taskPrompt(covers) : thread.title;
  const text = extra?.text ? `${brief}\n\n${extra.text}` : brief;
  const images = [...covers.flatMap((item) => item.images ?? []), ...(extra?.images ?? [])];
  try {
    await server.call("thread.send", { threadId: thread.id, message: { text, images } });
    return true;
  } catch (error) {
    reportError("Could not start the task", error);
    return false;
  }
}

/** Folds tasks nobody started into another task. Returns it as it is now. */
export async function mergeTasks(threadId: string, from: string[]): Promise<Thread | undefined> {
  try {
    return await server.call("task.merge", { threadId, from });
  } catch (error) {
    return reportError("Could not put the tasks together", error);
  }
}

/** Takes one item off a task, as a task of its own in To do. */
export async function splitItem(threadId: string, itemId: string): Promise<Thread | undefined> {
  try {
    const split = await server.call("task.split", { threadId, itemId });
    toast.add({ title: "Split off into To do", description: split.title });
    return split;
  } catch (error) {
    return reportError("Could not split it off", error);
  }
}

export function setPinned(threadId: string, pinned: boolean): void {
  const transaction = threads.update(threadId, (draft) => {
    draft.pinned = pinned;
  });
  transaction
    .when("settled")
    .catch((error: unknown) => reportError("Could not pin the thread", error));
}

export function setArchived(threadId: string, archived: boolean): void {
  const thread = threads.get(threadId);
  const transaction = threads.update(threadId, (draft) => {
    draft.archived = archived;
  });
  transaction.when("settled").then(
    () => {
      if (archived && thread) {
        withUndo("Archived", thread.title, () => setArchived(threadId, false));
      }
    },
    (error: unknown) => reportError("Could not archive the thread", error),
  );
}

function withUndo(title: string, description: string, undo: () => void): void {
  const id = toast.add({
    title,
    description,
    actionProps: {
      children: "Undo",
      onClick: () => {
        toast.close(id);
        undo();
      },
    },
  });
}

/** A chat that just became a task by changing files says so, and can stay a chat. */
function announcePromotion(before: Thread | undefined, after: Thread): void {
  if (!before || before.task || !after.task?.promoted) return;
  const id = toast.add({
    title: "It changed files, so it's now a task",
    description: after.title,
    actionProps: {
      children: "Keep as chat",
      onClick: () => {
        toast.close(id);
        void moveTask(after, null);
      },
    },
  });
}

export function renameThread(threadId: string, title: string): void {
  const transaction = threads.update(threadId, (draft) => {
    draft.title = title;
  });
  transaction
    .when("settled")
    .catch((error: unknown) => reportError("Could not rename the thread", error));
}

export function changeThreadSettings(threadId: string, changes: Partial<ThreadSettings>): void {
  const transaction = threads.update(threadId, (draft) => {
    draft.settings = { ...draft.settings, ...changes };
  });
  transaction
    .when("settled")
    .catch((error: unknown) => reportError("Could not change the thread's settings", error));
}

export function deleteThread(threadId: string): void {
  const transaction = threads.delete(threadId);
  transaction
    .when("settled")
    .catch((error: unknown) => reportError("Could not delete the thread", error));
}
