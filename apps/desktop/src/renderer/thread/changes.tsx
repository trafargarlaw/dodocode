// What a started thread's work changed in one of its repositories, file by file, in the panel
// beside the conversation: how it splits into code, tests, docs and setup, the changed files as
// a tree, and each file's diff.

import {
  memo,
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import type { FileChange, Project, Thread, WorkChanges, WorkRepo } from "@dodocode/protocol";
import {
  ArrowDataTransferVerticalIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  FoldVerticalIcon,
  FolderTreeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { CodeBlockCopyButton } from "@dodocode/ui/components/code-block";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { VisualStudioCodeLogo } from "../brand-icons";
import { Tip } from "../keys";
import { openThreadInEditor } from "../server/app-data";
import { diffLines } from "./blocks";
import { useChangeCount } from "./change-count";
import {
  breakdown,
  ROLE_LABEL,
  ROLES,
  roleOf,
  type Breakdown,
  type FileRole,
} from "./change-kinds";
import { changeRows, type ChangeRow, type FileEntry, type FileRow } from "./change-rows";
import { diffSource, hunkHeading, splitPath } from "./diff";
import { DIFF_TEXT, Hunk, LineRow } from "./diff-view";
import { useHighlightLater } from "./highlight-later";
import { PathTree, TREE_STATUS } from "./path-tree";
import type { WorkRead } from "./work-changes";
import { branchLabel, Counts, MergeButton } from "./workspace";

/** A file whose diff is longer than this starts folded, so the rest stays in reach. */
const FOLDED_PAST = 400;
/** A file's heading's height. */
const HEADING_PX = 36;
/** How far past the screen rows are drawn, so a fast scroll doesn't show them blank. */
const DRAWN_PAST_PX = 400;

const TREE_KEY = "dodocode.changesTree";

/** The name a changed file has now. */
function nowAt(change: FileChange): string {
  return change.movedTo ?? change.path;
}

export function ChangesView({
  thread,
  project,
  work,
  repo,
  inOwn,
  reveal,
}: {
  thread: Thread;
  project: Project;
  /** What the work changed in the repository shown. */
  work: WorkRead;
  /** The repository shown, once the server has read the thread's. */
  repo: WorkRepo | undefined;
  /** Whether it's the repository the thread works in, rather than another its work reached. */
  inOwn: boolean;
  /** A file to bring into view, each ask apart. */
  reveal?: { path: string; at: number };
}) {
  const state = work;
  const counted = useChangeCount(thread.id, thread.activityAt);
  // Each file opens or folds as it's clicked; until then, as its length says.
  const [folded, setFolded] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Steady, so a file is drawn again only when it opens or folds.
  const toggle = useCallback(
    (key: string, next: boolean) => setFolded((was) => new Map(was).set(key, next)),
    [],
  );
  // Only the files of one sort, when the person picked one, with the file the Files tab had
  // brought into view then.
  const [only, setOnly] = useState<{ role: FileRole; at?: number }>();
  const [treeShown, setTreeShown] = useState(() => {
    try {
      return localStorage.getItem(TREE_KEY) !== "hidden";
    } catch {
      return true;
    }
  });
  const showTree = (next: boolean) => {
    setTreeShown(next);
    try {
      localStorage.setItem(TREE_KEY, next ? "shown" : "hidden");
    } catch {
      // It still shows or hides; it just won't be kept.
    }
  };
  const worktree = inOwn ? thread.worktree : undefined;

  const all = useMemo<FileEntry[]>(
    () =>
      (state.changes?.files ?? []).map((change) => {
        const parsed = change.diff ? diffLines(change.diff) : undefined;
        return {
          key: `${change.path}:${change.kind}`,
          change,
          lines: parsed?.lines,
          source:
            parsed && parsed.lines.length > 0
              ? diffSource(parsed.lines, change.movedTo ?? change.path)
              : undefined,
          added: parsed?.added ?? 0,
          removed: parsed?.removed ?? 0,
        };
      }),
    [state.changes],
  );
  const parts = useMemo(() => breakdown(all), [all]);
  const roles = ROLES.filter((role) => parts.roles[role].files > 0);
  // A sort the files no longer have shows them all again, as a file the Files tab picks since
  // does, so it's in the list.
  const role =
    only && only.at === reveal?.at && parts.roles[only.role].files > 0 ? only.role : undefined;
  const entries = useMemo(
    () => (role ? all.filter((entry) => roleOf(nowAt(entry.change)) === role) : all),
    [all, role],
  );
  const truncated = !!state.changes?.truncated;
  const rows = useMemo(
    () =>
      changeRows(
        entries,
        (entry) => folded.get(entry.key) ?? (entry.lines?.length ?? 0) > FOLDED_PAST,
        truncated,
      ),
    [entries, folded, truncated],
  );
  const anyOpen = rows.some((row) => row.kind === "file" && !row.folded);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<VirtualizerHandle>(null);
  // Called as the list scrolls or its rows change size, so the pinned heading follows.
  const followRef = useRef<() => void>(undefined);
  const onMove = useCallback(() => followRef.current?.(), []);
  // A thread's changes show from their top.
  useLayoutEffect(() => {
    if (scrollerRef.current) scrollerRef.current.scrollTop = 0;
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the reason to go back up
  }, [state.of]);
  // Steady, so the rows in view are drawn again only when they change.
  const drawRow = useCallback(
    (row: ChangeRow) => <Row key={row.key} row={row} onToggle={toggle} />,
    [toggle],
  );

  /** Brings a file's heading to the top, opening the file if it's folded. */
  const goTo = (path: string): boolean => {
    const index = rows.findIndex((row) => row.kind === "file" && nowAt(row.entry.change) === path);
    const row = rows[index];
    if (row?.kind !== "file") return false;
    if (row.folded) toggle(row.key, false);
    listRef.current?.scrollToIndex(index);
    return true;
  };
  // A file the Files tab picked, once its changes are read, and only the once.
  const revealed = useRef<number>(undefined);
  const revealOnce = useEffectEvent((path: string, at: number) => {
    if (revealed.current === at) return;
    revealed.current = at;
    goTo(path);
  });
  useEffect(() => {
    if (reveal && state.changes) revealOnce(reveal.path, reveal.at);
  }, [reveal, state.changes]);

  // The count reads every line, where the diff leaves out what's too large to show. It counts
  // every repository the work is in, so it stands only for the one when there's one.
  const single = inOwn && (thread.repos?.length ?? 0) <= 1;
  const counts = (single && !role && counted) || {
    files: entries.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0),
    removed: entries.reduce((sum, entry) => sum + entry.removed, 0),
  };

  const { scope, explain } = scopeOf(thread, project, repo, inOwn, state.changes);
  const foldLabel = anyOpen ? "Fold every file" : "Open every file";
  const treeLabel = treeShown ? "Hide the files tree" : "Show the files tree";
  const treePaths = useMemo(() => entries.map((entry) => nowAt(entry.change)), [entries]);
  const treeStatus = useMemo(
    () =>
      entries.map((entry) => ({
        path: nowAt(entry.change),
        status: TREE_STATUS[entry.change.kind],
      })),
    [entries],
  );
  const tree = treeShown && entries.length > 1;

  return (
    <div className="@container flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-3 text-[12.5px]">
        <Tip label={explain}>
          <span className="shrink-0 font-medium">{scope}</span>
        </Tip>
        {entries.length > 0 && (
          <>
            <span className="truncate text-muted-foreground">
              {counts.files} {counts.files === 1 ? "file" : "files"}
            </span>
            <Counts added={counts.added} removed={counts.removed} />
          </>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {entries.length > 1 && (
            // Only where there's room for the tree beside the diff.
            <span className="hidden @min-[34rem]:contents">
              <Tip label={treeLabel}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={treeLabel}
                  aria-pressed={treeShown}
                  className="text-muted-foreground"
                  onClick={() => showTree(!treeShown)}
                >
                  <HugeiconsIcon icon={FolderTreeIcon} strokeWidth={1.8} />
                </Button>
              </Tip>
            </span>
          )}
          {entries.length > 1 && (
            <Tip label={foldLabel}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={foldLabel}
                className="text-muted-foreground"
                onClick={() =>
                  setFolded(new Map(entries.map((entry) => [entry.key, anyOpen] as const)))
                }
              >
                <HugeiconsIcon
                  icon={anyOpen ? FoldVerticalIcon : ArrowDataTransferVerticalIcon}
                  strokeWidth={1.8}
                />
              </Button>
            </Tip>
          )}
          {inOwn && (
            <Tip label="Open in VS Code">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Open in VS Code"
                className="text-muted-foreground"
                onClick={() => openThreadInEditor(thread.id)}
              >
                <VisualStudioCodeLogo className="size-3.5" />
              </Button>
            </Tip>
          )}
        </div>
      </div>
      {all.length > 0 && (
        <SortBar
          parts={parts}
          roles={roles}
          only={role}
          onOnly={(next) => setOnly(next && { role: next, at: reveal?.at })}
        />
      )}
      <div className="flex min-h-0 flex-1">
        {tree && (
          <div className="hidden w-[clamp(11rem,30%,18rem)] shrink-0 flex-col border-r @min-[34rem]:flex">
            <PathTree
              paths={treePaths}
              status={treeStatus}
              open
              label="Changed files"
              onOpen={goTo}
              className="px-1 pt-1"
            />
          </div>
        )}
        <div ref={scrollerRef} className="min-h-0 min-w-0 flex-1 overflow-y-auto">
          {state.error ? (
            <p className="p-4 text-[13px] text-destructive">{state.error}</p>
          ) : !state.changes ? (
            <div className="grid h-40 place-items-center">
              <Spinner className="size-5 text-muted-foreground" />
            </div>
          ) : entries.length === 0 ? (
            <p className="grid h-40 place-items-center text-[13px] text-muted-foreground">
              Nothing has changed yet.
            </p>
          ) : (
            <>
              <PinnedHeading
                rows={rows}
                listRef={listRef}
                followRef={followRef}
                onToggle={toggle}
              />
              <Virtualizer
                // A thread's rows measure afresh, rather than take the sizes another's had.
                key={state.of}
                ref={listRef}
                scrollRef={scrollerRef}
                data={rows}
                bufferSize={DRAWN_PAST_PX}
                onScroll={onMove}
                onResize={onMove}
              >
                {drawRow}
              </Virtualizer>
            </>
          )}
        </div>
      </div>
      {worktree?.base && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          <MergeButton thread={thread} disabled={all.length === 0 && !!state.changes} />
        </div>
      )}
    </div>
  );
}

/** What the changes shown are measured against, in a few words, and in full. */
function scopeOf(
  thread: Thread,
  project: Project,
  repo: WorkRepo | undefined,
  inOwn: boolean,
  changes: WorkChanges | undefined,
): { scope: string; explain: string } {
  const worktree = inOwn ? thread.worktree : undefined;
  const branch = repo?.branch ?? (inOwn ? branchLabel(thread, project) : "Detached HEAD");
  const against = changes ? changes.against : worktree?.base;
  if (worktree) {
    return {
      scope: `Against ${against ?? "where it started"}`,
      explain: `${worktree.branch}'s commits, and its edits not yet committed.`,
    };
  }
  const elsewhere = !inOwn
    ? "Edits made there outside this thread show too."
    : thread.origin?.checkout
      ? `Where it worked in ${thread.origin.app}. Edits made there outside this thread show too.`
      : `In ${project.name}'s folder. Your own edits there show too.`;
  if (against) {
    const pr =
      repo?.pr && repo.pr.base === against
        ? ` Pull request #${repo.pr.number} merges into it.`
        : "";
    return {
      scope: `Against ${against}`,
      explain: `What ${branch} changed since it left ${against}, and what isn't committed.${pr} ${elsewhere}`,
    };
  }
  if (changes?.since) {
    return {
      scope: "Since it started",
      explain: `What changed on ${branch} after ${changes.since.slice(0, 7)}, where it was as the thread began, and what isn't committed. ${elsewhere}`,
    };
  }
  return { scope: "Not committed", explain: `On ${branch}. ${elsewhere}` };
}

/** How many of a sort: "1 file", "3 files". */
function filesText(count: number): string {
  return `${count} ${count === 1 ? "file" : "files"}`;
}

/**
 * How the changed files split: code, tests, docs and setup, which each pick only their own files
 * to show, and how many are new, gone or moved.
 */
function SortBar({
  parts,
  roles,
  only,
  onOnly,
}: {
  parts: Breakdown;
  /** The sorts that have files. */
  roles: readonly FileRole[];
  only: FileRole | undefined;
  onOnly: (role: FileRole | undefined) => void;
}) {
  // With one sort, there's nothing to pick between.
  const picks = roles.length > 1;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-2 py-1.5 text-[12px]">
      {roles.map((role) => {
        const tally = parts.roles[role];
        const on = only === role;
        const what = `${ROLE_LABEL[role]}: ${filesText(tally.files)}, +${tally.added} −${tally.removed}`;
        const content = (
          <>
            <span className={cn(!on && "text-muted-foreground")}>{ROLE_LABEL[role]}</span>
            <span className="tabular-nums">{tally.files}</span>
          </>
        );
        if (!picks) {
          return (
            <Tip key={role} label={what}>
              <span className="flex h-6 items-center gap-1 px-1.5">{content}</span>
            </Tip>
          );
        }
        return (
          <Tip key={role} label={on ? "Show every file" : `${what}. Show only these`}>
            <button
              type="button"
              aria-pressed={on}
              onClick={() => onOnly(on ? undefined : role)}
              className={cn(
                "flex h-6 items-center gap-1 rounded-md border px-1.5 outline-none focus-visible:ring-2 focus-visible:ring-ring",
                on ? "border-transparent bg-accent text-accent-foreground" : "hover:bg-muted",
              )}
            >
              {content}
              {on && (
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} aria-hidden className="size-3" />
              )}
            </button>
          </Tip>
        );
      })}
      <span className="ml-auto flex items-center gap-2 px-1 tabular-nums">
        {parts.added > 0 && <span className={KIND_NOTE.add?.className}>{parts.added} new</span>}
        {parts.deleted > 0 && (
          <span className={KIND_NOTE.delete?.className}>{parts.deleted} deleted</span>
        )}
        {parts.moved > 0 && <span className="text-muted-foreground">{parts.moved} moved</span>}
      </span>
    </div>
  );
}

const KIND_NOTE: Partial<Record<FileChange["kind"], { label: string; className: string }>> = {
  add: { label: "New", className: "text-emerald-700 dark:text-emerald-400" },
  delete: { label: "Deleted", className: "text-red-700 dark:text-red-400" },
  move: { label: "Moved", className: "text-muted-foreground" },
};

const Row = memo(function Row({
  row,
  onToggle,
}: {
  row: ChangeRow;
  onToggle: (key: string, folded: boolean) => void;
}) {
  switch (row.kind) {
    case "note":
      return (
        <p className="border-b px-3 py-2 text-[12px] text-muted-foreground">
          Some of it is too large to show here. Open it in VS Code to see all of it.
        </p>
      );
    case "file":
      return (
        <FileHeading entry={row.entry} folded={row.folded} ruled={row.ruled} onToggle={onToggle} />
      );
    case "empty":
      return (
        <p className={cn("px-4 py-3 text-[12px] text-muted-foreground", row.ruled && "border-b")}>
          {row.entry.change.diff === undefined
            ? "Too large, or not text, to show here."
            : "No lines changed."}
        </p>
      );
    case "line":
      return row.line.kind === "hunk" ? (
        <div className={bodyClass(row)} style={row.source.style}>
          <Hunk heading={hunkHeading(row.line.text)} />
        </div>
      ) : (
        <ChangedLine row={row} />
      );
  }
});

type ChangedRow = Extract<ChangeRow, { kind: "line" }>;

/** Room above a file's first row and below its last, and the line between files. */
function bodyClass(row: ChangedRow): string {
  return cn(DIFF_TEXT, row.top && "pt-1", row.bottom && "pb-1", row.ruled && "border-b");
}

/** One of a file's lines, in its colours once its file is highlighted. */
function ChangedLine({ row }: { row: ChangedRow }) {
  const { source } = row;
  const highlighted = useHighlightLater(source.code, source.language);
  return (
    <div className={bodyClass(row)} style={source.style}>
      <LineRow line={row.line} content={highlighted?.[row.at]} />
    </div>
  );
}

/**
 * The heading of the open file whose lines fill the top of the list, pinned there once its own
 * scrolls away, and pushed up by the next file's as that comes. Folding it there brings the file
 * back to the top.
 */
function PinnedHeading({
  rows,
  listRef,
  followRef,
  onToggle,
}: {
  rows: readonly ChangeRow[];
  listRef: RefObject<VirtualizerHandle | null>;
  /** Takes what to call as the list moves. */
  followRef: RefObject<(() => void) | undefined>;
  onToggle: (key: string, folded: boolean) => void;
}) {
  const [pinned, setPinned] = useState<{ row: FileRow; shift: number }>();

  useLayoutEffect(() => {
    const look = () => {
      const handle = listRef.current;
      if (!handle) return;
      const top = handle.scrollOffset;
      const heading = rows[rows[handle.findItemIndex(top)]?.heading ?? -1];
      const next =
        heading?.kind === "file" && !heading.folded && handle.getItemOffset(heading.heading) < top
          ? {
              row: heading,
              // Up by as much as the next file's heading has come into its place.
              shift:
                heading.next < 0
                  ? 0
                  : Math.min(0, handle.getItemOffset(heading.next) - top - HEADING_PX),
            }
          : undefined;
      setPinned((was) => (was?.row === next?.row && was?.shift === next?.shift ? was : next));
    };
    followRef.current = look;
    look();
    return () => {
      followRef.current = undefined;
    };
  }, [rows, listRef, followRef]);

  const row = pinned?.row;
  const fold = useCallback(
    (key: string, folded: boolean) => {
      if (row) listRef.current?.scrollToIndex(row.heading);
      onToggle(key, folded);
    },
    [row, listRef, onToggle],
  );

  return (
    // Stays at the top as the list scrolls, taking no room from it.
    <div className="sticky top-0 z-[2] h-0">
      {pinned && (
        <div style={{ transform: `translateY(${pinned.shift}px)` }}>
          <FileHeading entry={pinned.row.entry} folded={false} ruled onToggle={fold} />
        </div>
      )}
    </div>
  );
}

/** A file's name and counts, which folds its lines away or opens them. */
const FileHeading = memo(function FileHeading({
  entry,
  folded,
  ruled,
  onToggle,
}: {
  entry: FileEntry;
  folded: boolean;
  /** With a line under it. */
  ruled: boolean;
  onToggle: (key: string, folded: boolean) => void;
}) {
  const { change, lines } = entry;
  const { folder, name } = splitPath(change.path);
  const note = KIND_NOTE[change.kind];
  return (
    <div
      className={cn(
        "group/file flex h-9 items-center gap-2 bg-background pr-2 pl-1.5",
        ruled && "border-b",
      )}
    >
      <button
        type="button"
        aria-expanded={!folded}
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-muted focus-visible:bg-muted"
        onClick={() => onToggle(entry.key, !folded)}
      >
        {/* Always shown, so a heading that folds never looks like one that opens something. */}
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={2}
          aria-hidden
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            folded && "-rotate-90",
          )}
        />
        <Tip label={change.movedTo ? `${change.path} → ${change.movedTo}` : change.path}>
          <span className="flex min-w-0 font-mono text-[12px]">
            {folder && <span className="truncate text-muted-foreground">{folder}</span>}
            <span className="shrink-0 font-medium text-foreground">{name}</span>
          </span>
        </Tip>
        {note && <span className={cn("shrink-0 text-[11.5px]", note.className)}>{note.label}</span>}
      </button>
      {lines && <Counts added={entry.added} removed={entry.removed} />}
      {change.diff && (
        <CodeBlockCopyButton
          value={change.diff}
          aria-label="Copy the diff"
          className="text-muted-foreground opacity-0 group-focus-within/file:opacity-100 group-hover/file:opacity-100"
        />
      )}
    </div>
  );
});
