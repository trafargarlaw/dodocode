// Every file in a repository a thread works in, as a tree, with the ones its work changed
// marked, and their folders open. Picking a changed file shows what changed in it.

import { useEffect, useMemo, useState } from "react";
import type { RepoFiles, Thread, WorkChanges } from "@dodocode/protocol";
import type { GitStatusEntry } from "@pierre/trees";
import { Spinner } from "@dodocode/ui/components/spinner";
import { threadFiles } from "../server/app-data";
import { foldersAbove, PathTree, TREE_STATUS } from "./path-tree";

const COUNT = new Intl.NumberFormat("en-US");

export function FilesView({
  thread,
  repo,
  changes,
  onOpenChange,
}: {
  thread: Thread;
  /** One of its other repositories, or unset for the one it works in. */
  repo: string | undefined;
  /** What its work changed there, once read. */
  changes: WorkChanges | undefined;
  /** Shows what changed in a file. */
  onOpenChange: (path: string) => void;
}) {
  const of = `${thread.id}\n${repo ?? ""}`;
  const [read, setRead] = useState<{ of: string; files?: RepoFiles; error?: string }>({ of });

  // Read again as a turn starts or ends, when files may have come or gone.
  useEffect(() => {
    let live = true;
    threadFiles(thread.id, repo).then(
      (files) => live && setRead({ of, files }),
      (error: unknown) =>
        live && setRead({ of, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the activity is the reason to read again
  }, [thread.id, repo, of, thread.activityAt]);
  const shown = read.of === of ? read : { of };

  const changed = useMemo(() => {
    const byPath = new Map<string, GitStatusEntry>();
    for (const change of changes?.files ?? []) {
      const path = change.movedTo ?? change.path;
      byPath.set(path, { path, status: TREE_STATUS[change.kind] });
    }
    return byPath;
  }, [changes]);
  const status = useMemo(() => [...changed.values()], [changed]);
  // A deleted file is no longer there to list, but still shows, marked as gone.
  const paths = useMemo(() => {
    const listed = shown.files?.paths ?? [];
    const there = new Set(listed);
    const gone = status.filter((entry) => entry.status === "deleted" && !there.has(entry.path));
    return gone.length === 0 ? listed : [...listed, ...gone.map((entry) => entry.path)];
  }, [shown.files, status]);
  const expanded = useMemo(() => foldersAbove(changed.keys()), [changed]);

  if (shown.error) return <p className="p-4 text-[13px] text-destructive">{shown.error}</p>;
  if (!shown.files) {
    return (
      <div className="grid h-40 place-items-center">
        <Spinner className="size-5 text-muted-foreground" />
      </div>
    );
  }
  if (paths.length === 0) {
    return (
      <p className="grid h-40 place-items-center text-[13px] text-muted-foreground">
        {shown.files.repo ? "No files here yet." : "It doesn't work in a repository."}
      </p>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-[12.5px] text-muted-foreground">
        <span className="tabular-nums">
          {COUNT.format(paths.length)} {paths.length === 1 ? "file" : "files"}
          {shown.files.truncated && ", and more not listed"}
        </span>
        {changed.size > 0 && (
          <span className="tabular-nums">· {COUNT.format(changed.size)} changed</span>
        )}
      </div>
      <PathTree
        key={of}
        paths={paths}
        status={status}
        open={false}
        expanded={expanded}
        search
        label="Files"
        onOpen={(path) => changed.has(path) && onOpenChange(path)}
        className="px-1 pt-1"
      />
    </div>
  );
}
