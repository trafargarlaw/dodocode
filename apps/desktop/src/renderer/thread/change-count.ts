// How many lines a thread's work changed, read as the thread opens so it shows before the diff
// is asked for. It's read again when the thread's activity moves, as a turn starts or ends.

import { useEffect, useState } from "react";
import type { ChangeCount } from "@dodocode/protocol";
import { threadChangeCount } from "../server/app-data";

/** The read for each thread at its latest activity, which the row and the details share. */
const reads = new Map<string, { at: number; count: Promise<ChangeCount | undefined> }>();
/** The latest count each thread was read at, which shows while it's read again. */
const latest = new Map<string, ChangeCount>();

function read(threadId: string, at: number): Promise<ChangeCount | undefined> {
  const kept = reads.get(threadId);
  if (kept?.at === at) return kept.count;
  const entry = { at, count: Promise.resolve<ChangeCount | undefined>(undefined) };
  entry.count = threadChangeCount(threadId).then(
    (count) => {
      // A read that an older activity started doesn't replace a newer one.
      if (reads.get(threadId) === entry) latest.set(threadId, count);
      return latest.get(threadId);
    },
    // Without a count, nothing shows; the diff says what went wrong once it's opened.
    () => latest.get(threadId),
  );
  reads.set(threadId, entry);
  return entry.count;
}

/** What a started thread's work changed, as of `at`, its latest activity. */
export function useChangeCount(threadId: string, at: number): ChangeCount | undefined {
  const [shown, setShown] = useState(() => ({ threadId, count: latest.get(threadId) }));
  useEffect(() => {
    let live = true;
    void read(threadId, at).then((count) => live && setShown({ threadId, count }));
    return () => {
      live = false;
    };
  }, [threadId, at]);
  return shown.threadId === threadId ? shown.count : latest.get(threadId);
}
