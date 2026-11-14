import { expect, test } from "vitest";
import type { FileChange } from "@dodocode/protocol";
import { diffLines } from "./blocks";
import { changeRows, type FileEntry } from "./change-rows";
import { diffSource } from "./diff";

function entry(change: FileChange): FileEntry {
  const parsed = change.diff ? diffLines(change.diff) : undefined;
  return {
    key: change.path,
    change,
    lines: parsed?.lines,
    source: parsed && diffSource(parsed.lines, change.path),
    added: parsed?.added ?? 0,
    removed: parsed?.removed ?? 0,
  };
}

test("rows: each file's heading, its lines while open, and where each heading is", () => {
  const entries = [
    entry({ path: "a.ts", kind: "update", diff: "@@ -1,2 +1,3 @@\n a\n+b\n@@ -40 +41 @@ f\n-c\n" }),
    // Too large to show.
    entry({ path: "b.bin", kind: "update" }),
    entry({ path: "c.ts", kind: "add", diff: "@@ -0,0 +1 @@\n+d\n" }),
  ];
  const rows = changeRows(entries, (file) => file.key === "c.ts", true);

  expect(
    rows.map((row) =>
      row.kind === "file"
        ? [row.kind, row.key, row.ruled, row.next]
        : row.kind === "note"
          ? [row.kind]
          : [row.kind, row.key, row.heading, row.top, row.bottom, row.ruled],
    ),
  ).toEqual([
    ["note"],
    ["file", "a.ts", true, 6],
    // The hunk that starts the file leaves nothing out, so it isn't a row.
    ["line", "a.ts:1", 1, true, false, false],
    ["line", "a.ts:2", 1, false, false, false],
    ["line", "a.ts:3", 1, false, false, false],
    ["line", "a.ts:4", 1, false, true, true],
    ["file", "b.bin", true, 8],
    ["empty", "b.bin:empty", 6, true, true, true],
    // Folded, and last, so nothing under it.
    ["file", "c.ts", false, -1],
  ]);
  // Each line's place in the file's code, which holds no hunks.
  expect(rows.flatMap((row) => (row.kind === "line" ? [row.at] : []))).toEqual([0, 1, -1, 2]);
});
