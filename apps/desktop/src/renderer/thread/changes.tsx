// What a started thread's work changed, file by file, in the panel beside the conversation.

import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import { Virtualizer, type VirtualizerHandle } from "virtua";
import type { FileChange, Project, Thread, WorkChanges } from "@dodocode/protocol";
import {
  ArrowDataTransferVerticalIcon,
  ArrowDown01Icon,
  FoldVerticalIcon,
  VisualStudioCodeIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import { CodeBlockCopyButton } from "@dodocode/ui/components/code-block";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { Tip } from "../keys";
import { openThreadInEditor, threadChanges } from "../server/app-data";
import { diffLines } from "./blocks";
import { useChangeCount } from "./change-count";
import { changeRows, type ChangeRow, type FileEntry, type FileRow } from "./change-rows";
import { diffSource, hunkHeading, splitPath } from "./diff";
import { DIFF_TEXT, Hunk, LineRow } from "./diff-view";
import { useHighlightLater } from "./highlight-later";
import { branchLabel, Counts, MergeButton } from "./workspace";

/** A file whose diff is longer than this starts folded, so the rest stays in reach. */
const FOLDED_PAST = 400;
/** A file's heading's height. */
const HEADING_PX = 36;
/** How far past the screen rows are drawn, so a fast scroll doesn't show them blank. */
const DRAWN_PAST_PX = 400;

export function ChangesView({ thread, project }: { thread: Thread; project: Project }) {
  // Which thread's changes they are, so a thread's list starts at its top.
  const [state, setState] = useState<{ of?: string; changes?: WorkChanges; error?: string }>({});
  const counted = useChangeCount(thread.id, thread.activityAt);
  // Each file opens or folds as it's clicked; until then, as its length says.
  const [folded, setFolded] = useState<ReadonlyMap<string, boolean>>(new Map());
  // Steady, so a file is drawn again only when it opens or folds.
  const toggle = useCallback(
    (key: string, next: boolean) => setFolded((was) => new Map(was).set(key, next)),
    [],
  );
  const worktree = thread.worktree;

  // Read again when a turn starts or ends, the times its activity moves, so what shows is
  // what's there.
  useEffect(() => {
    let live = true;
    const of = thread.id;
    threadChanges(of).then(
      (changes) => live && setState({ of, changes }),
      (error: unknown) =>
        live && setState({ of, error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the reason to read again
  }, [thread.id, thread.activityAt]);

  const entries = useMemo<FileEntry[]>(
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
  // The count reads every line, where the diff leaves out what's too large to show.
  const counts = counted ?? {
    files: entries.length,
    added: entries.reduce((sum, entry) => sum + entry.added, 0),
    removed: entries.reduce((sum, entry) => sum + entry.removed, 0),
  };

  const scope = worktree ? `Against ${worktree.base ?? "where it started"}` : "Not committed";
  const explain = worktree
    ? `${worktree.branch}'s commits, and its edits not yet committed.`
    : thread.origin?.checkout
      ? `On ${branchLabel(thread, project)}, where it worked in ${thread.origin.app}. Edits made there outside this thread show too.`
      : `On ${branchLabel(thread, project)}, in ${project.name}'s folder. Your own edits there show too.`;
  const foldLabel = anyOpen ? "Fold every file" : "Open every file";

  return (
    <div className="flex min-h-0 flex-1 flex-col">
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
          <Tip label="Open in VS Code">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Open in VS Code"
              className="text-muted-foreground"
              onClick={() => openThreadInEditor(thread.id)}
            >
              <HugeiconsIcon icon={VisualStudioCodeIcon} strokeWidth={1.8} />
            </Button>
          </Tip>
        </div>
      </div>
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
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
            <PinnedHeading rows={rows} listRef={listRef} followRef={followRef} onToggle={toggle} />
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
      {worktree?.base && (
        <div className="flex items-center justify-end gap-2 border-t px-3 py-2">
          <MergeButton thread={thread} disabled={entries.length === 0 && !!state.changes} />
        </div>
      )}
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
