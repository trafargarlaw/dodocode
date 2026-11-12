import { useSyncExternalStore } from "react";

const TICK_MS = 30_000;
let now = Date.now();
const listeners = new Set<() => void>();
let timer: number | undefined;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  timer ??= window.setInterval(() => {
    now = Date.now();
    for (const each of Array.from(listeners)) each();
  }, TICK_MS);
  return () => {
    listeners.delete(listener);
    if (listeners.size > 0) return;
    window.clearInterval(timer);
    timer = undefined;
  };
}

/** The time, updated every half minute: enough for "5m ago". One timer serves every reader. */
export function useNow(): number {
  return useSyncExternalStore(subscribe, () => now);
}

/** How long ago, in the fewest characters: `now`, `5m`, `3h`, `2d`, `6w`. */
export function ago(at: number, current: number): string {
  const minutes = Math.floor((current - at) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return `${Math.floor(days / 7)}w`;
}

/** A duration as people say it: `0.4s`, `12s`, `3m 05s`, `1h 02m`. */
export function duration(ms: number): string {
  // Below 9.95s a tenth still shows; from there it would round to `10.0s`.
  if (ms < 9_950) return `${(ms / 1000).toFixed(1)}s`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}
