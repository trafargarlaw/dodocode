import { expect, test } from "vitest";
import { costSince, slashCommands } from "./claude";

test("slashCommands offers what a message can run, and drops the rest", () => {
  const commands = slashCommands(
    [
      { name: "compact", description: "Free up context", argumentHint: "<instructions>" },
      { name: "autocompact", description: "When to compact", argumentHint: "" },
      { name: "theme", description: "Change the theme", argumentHint: "" },
      { name: "__remote-workflow", description: "Internal", argumentHint: "" },
      { name: "pr-comments", description: "(removed) Use the GitHub CLI", argumentHint: "" },
      { name: "bug", description: "Renamed to /feedback", argumentHint: "" },
    ],
    new Set(["theme"]),
  );
  expect(commands).toEqual([
    { name: "compact", description: "Free up context", argumentHint: "<instructions>" },
    { name: "autocompact", description: "When to compact" },
  ]);
});

test.each([
  // A resumed session's total carries the earlier turns.
  { total: 2.25, before: 1.5, cost: 0.75, after: 2.25 },
  // After /clear the total starts again.
  { total: 0.5, before: 2.25, cost: 0.5, after: 0.5 },
  // A crashed turn's result carries zero.
  { total: 0, before: 2.25, cost: 0, after: 2.25 },
])(
  "a turn costs what the total grew by: $total after $before",
  ({ total, before, cost, after }) => {
    expect(costSince(total, before)).toEqual({ cost, total: after });
  },
);
