// A file's diff, line by line: numbered, tinted by what changed, and highlighted as its language.

import { memo, useMemo, type ReactNode } from "react";
import { cn } from "@dodocode/ui/lib/utils";
import type { DiffLine } from "./blocks";
import { diffSource, hunkHeading, startsFile } from "./diff";
import { useHighlightLater } from "./highlight-later";

/** Rows the page lays out together, or skips together while they're off the screen. */
const GROUP_ROWS = 40;
/** A row's height, unless its line wraps. */
const ROW_PX = 20;

/** The text of a diff's rows. Set `--digits` on it too, for the numbers' column. */
export const DIFF_TEXT = "font-mono text-[12px] leading-5 [tab-size:4]";

const ROW_TINT: Record<DiffLine["kind"], string> = {
  added: "bg-emerald-500/10 dark:bg-emerald-400/10",
  removed: "bg-red-500/10 dark:bg-red-400/10",
  context: "",
  hunk: "",
};

/** The number's column, a shade deeper than its row. */
const GUTTER_TINT: Record<DiffLine["kind"], string> = {
  added: "bg-emerald-500/10 text-emerald-700/70 dark:bg-emerald-400/10 dark:text-emerald-300/60",
  removed: "bg-red-500/10 text-red-700/70 dark:bg-red-400/10 dark:text-red-300/60",
  context: "text-muted-foreground/60",
  hunk: "",
};

const MARK: Record<DiffLine["kind"], ReactNode> = {
  added: <span className="text-emerald-600 dark:text-emerald-400">+</span>,
  removed: <span className="text-red-600 dark:text-red-400">−</span>,
  context: null,
  hunk: null,
};

export const DiffRows = memo(function DiffRows({
  lines,
  path,
  className,
}: {
  lines: DiffLine[];
  /** The file's path, which says what language it's in. */
  path: string;
  className?: string;
}) {
  // The rows in groups, each of which the page lays out and paints only while it's near the
  // screen.
  const { source, groups } = useMemo(() => {
    const grouped: { line: DiffLine; index: number }[][] = [];
    for (let start = 0; start < lines.length; start += GROUP_ROWS) {
      grouped.push(
        lines.slice(start, start + GROUP_ROWS).map((line, offset) => ({
          line,
          index: start + offset,
        })),
      );
    }
    return { source: diffSource(lines, path), groups: grouped };
  }, [lines, path]);
  const highlighted = useHighlightLater(source.code, source.language);

  return (
    <div className={cn(DIFF_TEXT, className)} style={source.style}>
      {groups.map((group) => (
        <div
          // Groups have no identity but their place.
          key={group[0]?.index}
          style={{
            contentVisibility: "auto",
            // Its height until it's first drawn, from then on the height it had.
            containIntrinsicSize: `auto ${group.length * ROW_PX}px`,
          }}
        >
          {group.map(({ line, index }) =>
            line.kind === "hunk" ? (
              startsFile(line, index) ? null : (
                // Lines have no identity but their place.
                // oxlint-disable-next-line react/no-array-index-key
                <Hunk key={index} heading={hunkHeading(line.text)} />
              )
            ) : (
              // oxlint-disable-next-line react/no-array-index-key
              <LineRow key={index} line={line} content={highlighted?.[source.at[index] ?? -1]} />
            ),
          )}
        </div>
      ))}
    </div>
  );
});

/** One line: its number, whether it was added or removed, and its code. */
export function LineRow({ line, content }: { line: DiffLine; content: ReactNode | undefined }) {
  return (
    <div className={cn("flex", ROW_TINT[line.kind])}>
      <span
        className={cn(
          "w-[calc(var(--digits)+1.25rem)] shrink-0 pr-2 text-right tabular-nums select-none",
          GUTTER_TINT[line.kind],
        )}
      >
        {line.kind === "removed" ? line.before : line.after}
      </span>
      <span aria-hidden className="w-5 shrink-0 text-center select-none">
        {MARK[line.kind]}
      </span>
      <span className="min-w-0 flex-1 pr-3 break-words whitespace-pre-wrap">
        {/* Plain until its colours come, and a space keeps an empty line's height. */}
        {line.text ? (content ?? line.text) : "​"}
      </span>
    </div>
  );
}

/** Where lines the diff leaves out would be, under the function or block that follows. */
export function Hunk({ heading }: { heading: string }) {
  return (
    <div className="flex h-7 items-center border-y border-border/60 bg-muted/60 text-[11.5px] text-muted-foreground">
      <span
        aria-hidden
        className="w-[calc(var(--digits)+1.25rem)] shrink-0 pr-2 text-right select-none"
      >
        ⋯
      </span>
      <span className="w-5 shrink-0" />
      <span className="min-w-0 truncate pr-3">{heading}</span>
    </div>
  );
}
