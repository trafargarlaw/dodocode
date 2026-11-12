// What the sidebar and the board show: one filter for both, kept between launches.

import { useSyncExternalStore } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { projects } from "./server/app-data";
import type { ListFilter } from "./task-list";

const KEY = "dodocode:filter";

function load(): ListFilter {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<ListFilter> | null;
    return {
      projectId: typeof saved?.projectId === "string" ? saved.projectId : undefined,
      needsYou: saved?.needsYou === true,
    };
  } catch {
    return { needsYou: false };
  }
}

let current = load();
const listeners = new Set<() => void>();

export function setListFilter(change: Partial<ListFilter>): void {
  current = { ...current, ...change };
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    // The filter still applies; it just won't be there next launch.
  }
  for (const listener of Array.from(listeners)) listener();
}

/** The filter, showing all projects once the one it names is gone. */
export function useListFilter(): ListFilter {
  const filter = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => current,
  );
  const { data: projectList = [], isReady } = useLiveQuery({
    query: (q) => q.from({ project: projects }).orderBy(({ project }) => project.createdAt, "asc"),
  });
  const known = !isReady || projectList.some((project) => project.id === filter.projectId);
  return filter.projectId && !known ? { ...filter, projectId: undefined } : filter;
}
