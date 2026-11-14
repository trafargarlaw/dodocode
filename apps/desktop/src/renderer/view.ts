// What the sheet shows: a thread, a new thread being written, or the board. Kept between launches,
// so the window opens where it was.

import { useSyncExternalStore } from "react";

export type View =
  /** A thread. Opened from the board, its header leads back there. */
  | { kind: "thread"; threadId: string; from?: "board" }
  /** A new thread, in the project picked for it: `null` for none, unset for the usual one. */
  | { kind: "draft"; projectId?: string | null }
  | { kind: "board" };

const KEY = "dodocode:view";

function load(): View {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as View | null;
    if (saved?.kind === "thread" && typeof saved.threadId === "string") {
      const { threadId } = saved;
      return saved.from === "board"
        ? { kind: "thread", threadId, from: "board" }
        : { kind: "thread", threadId };
    }
    if (saved?.kind === "draft") return { kind: "draft", projectId: saved.projectId };
    if (saved?.kind === "board") return saved;
  } catch {
    // Nothing saved, or storage is off: start on a new thread.
  }
  return { kind: "draft" };
}

let current = load();
/** Whether the new thread is asking which project it works in. Not kept between launches. */
let choosing = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of Array.from(listeners)) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function set(view: View, choose = false): void {
  current = view;
  choosing = choose;
  try {
    localStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    // The view still changes; it just won't be there next launch.
  }
  notify();
}

/** Opens a thread. `from` the board, its header has a way back there. */
export function openThread(threadId: string, from?: "board"): void {
  if (current.kind === "thread" && current.threadId === threadId && current.from === from) return;
  set(from ? { kind: "thread", threadId, from } : { kind: "thread", threadId });
}

/**
 * Opens a thread of the same work, such as a task's review or one of its subagents, keeping the
 * way back to where the open thread was opened from.
 */
export function openRelated(threadId: string): void {
  openThread(threadId, current.kind === "thread" ? current.from : undefined);
}

/**
 * Opens a new thread. `chooseProject` asks which project it works in, with this one picked
 * already, so a person who wanted it only has to go on.
 */
export function openDraft(
  projectId?: string | null,
  { chooseProject = false }: { chooseProject?: boolean } = {},
): void {
  set({ kind: "draft", projectId }, chooseProject);
}

/** Opens or closes the new thread's question of which project it works in. */
export function setChoosingProject(open: boolean): void {
  if (choosing === open) return;
  choosing = open;
  notify();
}

export function openBoard(): void {
  if (current.kind !== "board") set({ kind: "board" });
}

export function getView(): View {
  return current;
}

export function useView(): View {
  return useSyncExternalStore(subscribe, () => current);
}

export function useChoosingProject(): boolean {
  return useSyncExternalStore(subscribe, () => choosing);
}
