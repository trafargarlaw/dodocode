import { expect, test } from "vitest";

import type { Finding, Thread } from "./domain";
import { disputesWaiting, findingCounts, latestReviews } from "./reviews";

function finding(id: string, group: string, fields: Partial<Finding> = {}): Finding {
  return { id, group, kind: "violation", summary: id, ...fields };
}

const findings = [
  finding("f1", "Spec"),
  finding("f2", "Standards", { answer: { outcome: "disputed", note: "Intended." } }),
  finding("f3", "Spec", { answer: { outcome: "disputed", note: "Intended." }, decision: "agree" }),
  finding("f4", "Standards", { answer: { outcome: "fixed", note: "Done." } }),
];

test("each axis is counted on its own, in the order the reviewer reported them", () => {
  expect(findingCounts({ base: "a", baseLabel: "main", findings })).toEqual([
    { group: "Spec", count: 2 },
    { group: "Standards", count: 2 },
  ]);
});

test("a dispute waits for the person until they make their call", () => {
  const waiting = disputesWaiting({ base: "a", baseLabel: "main", findings });
  expect(waiting.map((entry) => entry.id)).toEqual(["f2"]);
});

function thread(id: string, fields: Partial<Thread>): Thread {
  return {
    id,
    kind: "main",
    title: id,
    status: "idle",
    settings: { provider: "claude", model: "m", effort: "", access: "full" },
    createdAt: 0,
    updatedAt: 0,
    activityAt: 0,
    ...fields,
  };
}

test("each task's latest review is the one started last", () => {
  const latest = latestReviews([
    thread("task", {}),
    thread("r1", { kind: "review", parentId: "task", createdAt: 1 }),
    thread("r2", { kind: "review", parentId: "task", createdAt: 3 }),
    thread("r3", { kind: "review", parentId: "task", createdAt: 2 }),
    thread("sub", { kind: "subagent", parentId: "other", createdAt: 9 }),
  ]);
  expect([...latest].map(([task, review]) => [task, review.id])).toEqual([["task", "r2"]]);
});
