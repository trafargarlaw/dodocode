import { describe, expect, test } from "vitest";
import type { Item } from "@dodocode/protocol";
import { diffLines, toBlocks, type DiffLine } from "./blocks";

const base = { threadId: "t", turnId: "turn", seq: 1, createdAt: 0 };

test("toBlocks groups thinking and tool calls in a row into one block, keyed by the first", () => {
  const items: Item[] = [
    { ...base, id: "u1", type: "user", text: "Fix it", images: [] },
    { ...base, id: "r1", type: "reasoning", text: "", streaming: false },
    {
      ...base,
      id: "t1",
      type: "tool",
      kind: "read",
      name: "Read",
      title: "a.ts",
      input: {},
      output: "",
      status: "done",
    },
    { ...base, id: "a1", type: "assistant", text: "Done.", streaming: false },
    {
      ...base,
      id: "t2",
      type: "tool",
      kind: "command",
      name: "Bash",
      title: "ls",
      input: {},
      output: "",
      status: "done",
    },
    { ...base, id: "e1", type: "turn_end", status: "completed", durationMs: 10 },
  ];
  const blocks = toBlocks(items, false).map((block) =>
    block.kind === "steps"
      ? [block.id, block.steps.map((step) => step.id)]
      : [block.id, block.kind],
  );
  expect(blocks).toEqual([
    ["u1", "user"],
    ["r1", ["r1", "t1"]],
    ["a1", "assistant"],
    ["t2", ["t2"]],
    ["e1", "turn_end"],
  ]);
});

test("while the thread runs, the steps after its last message are not settled", () => {
  const tool = (id: string): Item => ({
    ...base,
    id,
    type: "tool",
    kind: "command",
    name: "Bash",
    title: "ls",
    input: {},
    output: "",
    status: "done",
  });
  const items: Item[] = [
    { ...base, id: "u1", type: "user", text: "Fix it", images: [] },
    tool("t1"),
    { ...base, id: "a1", type: "assistant", text: "Looking.", streaming: false },
    tool("t2"),
    { ...base, id: "n1", type: "notice", level: "warning", text: "Slow network" },
    tool("t3"),
  ];
  const settled = (running: boolean) =>
    toBlocks(items, running).flatMap((block) =>
      block.kind === "steps" ? [[block.id, block.settled]] : [],
    );

  expect(settled(true)).toEqual([
    ["t1", true],
    ["t2", false],
    ["t3", false],
  ]);
  expect(settled(false)).toEqual([
    ["t1", true],
    ["t2", true],
    ["t3", true],
  ]);
});

describe("diffLines", () => {
  test.each<[string, string, DiffLine[], number, number]>([
    [
      "drops the file headers",
      "diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n",
      [
        { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
        { kind: "context", text: "keep" },
        { kind: "removed", text: "old" },
        { kind: "added", text: "new" },
      ],
      1,
      1,
    ],
    [
      "reads lines that look like headers inside a hunk as changes",
      "@@ -1 +1 @@\n--- a\n+++ b",
      [
        { kind: "hunk", text: "@@ -1 +1 @@" },
        { kind: "removed", text: "-- a" },
        { kind: "added", text: "++ b" },
      ],
      1,
      1,
    ],
    [
      "drops the missing-newline marker",
      "@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b",
      [
        { kind: "hunk", text: "@@ -1 +1 @@" },
        { kind: "removed", text: "a" },
        { kind: "added", text: "b" },
      ],
      1,
      1,
    ],
    [
      "drops the headers of a second file",
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n+x\ndiff --git a/y b/y\n--- a/y\n+++ b/y\n@@ -1 +0,0 @@\n-y",
      [
        { kind: "hunk", text: "@@ -1 +1 @@" },
        { kind: "added", text: "x" },
        { kind: "hunk", text: "@@ -1 +0,0 @@" },
        { kind: "removed", text: "y" },
      ],
      1,
      1,
    ],
  ])("%s", (_name, diff, lines, added, removed) => {
    expect(diffLines(diff)).toEqual({ lines, added, removed });
  });
});
