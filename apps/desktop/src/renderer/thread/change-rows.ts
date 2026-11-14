// The Changes panel as a list of rows, so it draws only those in view: each file's heading, then
// its lines while it's open.

import type { FileChange } from "@dodocode/protocol";
import type { DiffLine } from "./blocks";
import { startsFile, type DiffSource } from "./diff";

export interface FileEntry {
  key: string;
  change: FileChange;
  lines: DiffLine[] | undefined;
  /** Its lines' code, when it has lines. */
  source: DiffSource | undefined;
  added: number;
  removed: number;
}

/** The parts of a row that go under a file's heading. */
interface Body {
  key: string;
  entry: FileEntry;
  /** Where its file's heading is in the rows. */
  heading: number;
  /** The file's first row, with room above it. */
  top: boolean;
  /** The file's last row, with room below it. */
  bottom: boolean;
  /** With a line under it, to the next file. */
  ruled: boolean;
}

export type ChangeRow =
  /** That some of it is too large to show. */
  | { kind: "note"; key: string; heading: -1 }
  | {
      kind: "file";
      key: string;
      entry: FileEntry;
      /** Its own place, so every row can say where its heading is. */
      heading: number;
      folded: boolean;
      /** With a line under it: to its lines, or to the next file. */
      ruled: boolean;
      /** Where the next file's heading is, or -1 for the last. */
      next: number;
    }
  | (Body & {
      kind: "line";
      line: DiffLine;
      /** Its file's code. */
      source: DiffSource;
      /** Its place among the code's lines. */
      at: number;
    })
  /** A file whose lines don't show. */
  | (Body & { kind: "empty" });

export type FileRow = Extract<ChangeRow, { kind: "file" }>;

export function changeRows(
  entries: readonly FileEntry[],
  isFolded: (entry: FileEntry) => boolean,
  truncated: boolean,
): ChangeRow[] {
  const rows: ChangeRow[] = [];
  if (truncated) rows.push({ kind: "note", key: "note", heading: -1 });
  let previous: FileRow | undefined;
  entries.forEach((entry, place) => {
    const last = place === entries.length - 1;
    const folded = isFolded(entry);
    const heading = rows.length;
    const row: FileRow = {
      kind: "file",
      key: entry.key,
      entry,
      heading,
      folded,
      ruled: !folded || !last,
      next: -1,
    };
    if (previous) previous.next = heading;
    previous = row;
    rows.push(row);
    if (folded) return;

    const body = { entry, heading, top: false, bottom: false, ruled: false };
    const start = rows.length;
    const { lines, source } = entry;
    if (lines && source) {
      lines.forEach((line, index) => {
        if (startsFile(line, index)) return;
        const at = source.at[index] ?? -1;
        rows.push({ ...body, kind: "line", key: `${entry.key}:${index}`, line, source, at });
      });
    }
    if (rows.length === start) rows.push({ ...body, kind: "empty", key: `${entry.key}:empty` });
    const first = rows[start] as Body;
    const end = rows[rows.length - 1] as Body;
    first.top = true;
    end.bottom = true;
    end.ruled = !last;
  });
  return rows;
}
