// What a thread's work changed in one of its repositories, read once for the panel's tabs to
// share: the Changes tab shows the diff, the Files tab marks the files it touched.

import { useEffect, useState } from "react";
import type { WorkChanges } from "@dodocode/protocol";
import { threadChanges } from "../server/app-data";

export interface WorkRead {
  /** Which thread and repository the read is of, so a list starts at its top for each. */
  of: string;
  changes?: WorkChanges;
  error?: string;
}

/**
 * What the work changed in `repo`, or in the repository it works in when unset. Read again when
 * a turn starts or ends, the times `at`, its activity, moves, so what shows is what's there.
 */
export function useWorkChanges(threadId: string, at: number, repo: string | undefined): WorkRead {
  const of = `${threadId}\n${repo ?? ""}`;
  const [read, setRead] = useState<WorkRead>({ of });
  useEffect(() => {
    let live = true;
    threadChanges(threadId, repo).then(
      (changes) => live && setRead({ of, changes }),
      (error: unknown) =>
        live && setRead({ of, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `at` is the reason to read again
  }, [threadId, repo, at, of]);
  // Another repository's read doesn't show while this one's comes.
  return read.of === of ? read : { of };
}
