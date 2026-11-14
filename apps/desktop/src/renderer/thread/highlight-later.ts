// Code highlighted a few lines at a time, between frames, so a panel of diffs shows at once and
// takes its colours after; and kept, so a diff shown again has them from its first frame.

import { useEffect, useState, type ReactNode } from "react";
import { loadHighlighter } from "@dodocode/ui/lib/highlighter";

type Highlighter = NonNullable<Awaited<ReturnType<typeof loadHighlighter>>>;
type GrammarState = Parameters<Highlighter["highlight"]>[1];

/** How long highlighting holds the page at a time, which leaves a frame room to draw. */
const SLICE_MS = 6;
/** Lines highlighted in one go, between looks at the time. */
const STEP_LINES = 5;
/** Lines whose colours are kept, the least recently shown let go first. */
const KEPT_LINES = 10_000;

// Keyed by the code, whose string is the same object from render to render, so a lookup
// doesn't read it again.
const kept = new Map<string, { language: string; lines: ReactNode[] }>();
let keptLines = 0;

/** The colours kept for this code, if it was highlighted before. */
export function keptHighlight(code: string, language: string): ReactNode[] | undefined {
  const found = kept.get(code);
  if (!found || found.language !== language) return undefined;
  // Last in the map is the most recently shown.
  kept.delete(code);
  kept.set(code, found);
  return found.lines;
}

function keep(code: string, language: string, lines: ReactNode[]): void {
  const was = kept.get(code);
  if (was) keptLines -= was.lines.length;
  kept.delete(code);
  kept.set(code, { language, lines });
  keptLines += lines.length;
  for (const [oldest, entry] of kept) {
    if (keptLines <= KEPT_LINES || oldest === code) break;
    kept.delete(oldest);
    keptLines -= entry.lines.length;
  }
}

/**
 * Highlights code a few lines at a time, handing the page back between, and carries each piece's
 * grammar state into the next, so a comment or string over several lines keeps its colour. Null
 * for a language the highlighter doesn't know, or once `abandoned` says no one waits any more.
 */
export async function highlightInSlices(
  code: string,
  language: string,
  abandoned: () => boolean = () => false,
  step = STEP_LINES,
): Promise<ReactNode[] | null> {
  const highlighter = await loadHighlighter(language);
  if (!highlighter) return null;
  const source = code.split("\n");
  const lines: ReactNode[] = [];
  let state: GrammarState;
  let sliceStart = performance.now();
  for (let at = 0; at < source.length; at += step) {
    if (performance.now() - sliceStart > SLICE_MS) {
      await nextTask();
      if (abandoned()) return null;
      sliceStart = performance.now();
    }
    const result = highlighter.highlight(source.slice(at, at + step).join("\n"), state);
    lines.push(...result.lines);
    state = result.state;
  }
  return lines;
}

let channel: MessageChannel | undefined;
const nextTasks: (() => void)[] = [];

/**
 * Waits for a task of its own, behind what's queued, input and drawing among it. A message
 * comes back sooner than a timer, which waits 4ms once timers have set off timers.
 */
function nextTask(): Promise<void> {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.addEventListener("message", () => nextTasks.shift()?.());
    // A port listened to this way holds its messages until started.
    channel.port1.start();
  }
  const { port2 } = channel;
  return new Promise((resolve) => {
    nextTasks.push(resolve);
    port2.postMessage(null);
  });
}

interface Job {
  code: string;
  language: string;
  waiting: Set<(lines: ReactNode[]) => void>;
}

/** In the order they were asked for: a panel's diffs mount from the top down. */
const queue: Job[] = [];
let working = false;

async function work(): Promise<void> {
  working = true;
  for (let job = queue[0]; job; job = queue[0]) {
    const waiting = job.waiting;
    let lines: ReactNode[] | null = null;
    let gaveUp = false;
    if (waiting.size > 0) {
      try {
        lines = await highlightInSlices(
          job.code,
          job.language,
          () => (gaveUp = waiting.size === 0),
        );
      } catch {
        // It shows without colours.
      }
    }
    queue.shift();
    if (lines) {
      keep(job.code, job.language, lines);
      for (const done of waiting) done(lines);
    } else if (gaveUp && waiting.size > 0) {
      // Asked for again just as it was let go.
      queue.push(job);
    }
  }
  working = false;
}

/** Highlights code after what's queued, and calls `done` with it. The function returned stops waiting. */
export function highlightLater(
  code: string,
  language: string,
  done: (lines: ReactNode[]) => void,
): () => void {
  let job = queue.find((queued) => queued.code === code && queued.language === language);
  if (!job) {
    job = { code, language, waiting: new Set() };
    queue.push(job);
  }
  const { waiting } = job;
  waiting.add(done);
  if (!working) void work();
  return () => {
    waiting.delete(done);
  };
}

/** The code's lines highlighted, or nothing until they are: show them plain meanwhile. */
export function useHighlightLater(code: string, language: string): ReactNode[] | undefined {
  const [done, setDone] = useState<{ code: string; language: string; lines: ReactNode[] }>();
  const lines =
    done?.code === code && done.language === language ? done.lines : keptHighlight(code, language);
  const ready = lines !== undefined;
  useEffect(() => {
    if (ready) return;
    return highlightLater(code, language, (next) => setDone({ code, language, lines: next }));
  }, [code, language, ready]);
  return lines;
}
