import { describe, expect, test } from "vitest";
import type { Task, Thread } from "@dodocode/protocol";
import { itemFrom, merged, moved, promoted, split, started } from "./tasks";

function thread(fields: Partial<Thread> = {}): Thread {
  return {
    id: "t",
    projectId: "p",
    kind: "main",
    title: "Thread",
    status: "idle",
    settings: { provider: "claude", model: "m", effort: "", access: "supervised" },
    createdAt: 0,
    updatedAt: 0,
    activityAt: 0,
    ...fields,
  };
}

function todo(id: string, title: string, fields: Partial<Thread> = {}): Thread {
  const task: Task = { status: "todo", covers: [{ id: `${id}-item`, title }], movedAt: 0 };
  return thread({ id, title, task, ...fields });
}

test("a message makes an item titled by its first line, keeping all of it when there's more", () => {
  const short = itemFrom({ text: "  Fix the scrollbar  ", images: [] });
  expect(short.title).toBe("Fix the scrollbar");
  expect(short).not.toHaveProperty("body");
  expect(
    itemFrom({ text: "Fix the scrollbar\n\nIt overlaps the text.", images: [] }),
  ).toMatchObject({
    title: "Fix the scrollbar",
    body: "Fix the scrollbar\n\nIt overlaps the text.",
  });
  expect(() => itemFrom({ text: "  ", images: [] })).toThrow("Write what the task is for.");
});

describe("moving", () => {
  test("a chat becomes a task in the column it moves to", () => {
    const next = moved(thread({ startedAt: 1 }), "review", 5);
    expect(next.task).toEqual({ status: "review", covers: [], movedAt: 5 });
  });

  test("a task made a chat again stays a chat", () => {
    const next = moved(
      thread({ startedAt: 1, task: { status: "progress", covers: [], movedAt: 0 } }),
      null,
      5,
    );
    expect(next.task).toBeUndefined();
    expect(next.keepChat).toBe(true);
    expect(promoted(next, 6)).toBeUndefined();
  });

  test.each([
    [
      "a thread without a project",
      thread({ projectId: undefined }),
      "review",
      "Only a thread in a project can be a task.",
    ],
    [
      "a subagent's thread",
      thread({ kind: "subagent", parentId: "a" }),
      "todo",
      "A subagent's thread can't be a task.",
    ],
    [
      "a task nobody started, to a chat",
      todo("a", "A"),
      null,
      "This task hasn't started, so there is no chat to go back to.",
    ],
  ] as const)("%s can't move", (_name, from, to, message) => {
    expect(() => moved(from, to, 5)).toThrow(message);
  });
});

test("a chat that changes files becomes a task in progress, unless it can't or was kept a chat", () => {
  expect(promoted(thread(), 5)?.task).toEqual({
    status: "progress",
    covers: [],
    movedAt: 5,
    promoted: true,
  });
  expect(promoted(thread({ projectId: undefined }), 5)).toBeUndefined();
  expect(promoted(thread({ keepChat: true }), 5)).toBeUndefined();
  expect(promoted(todo("a", "A"), 5)).toBeUndefined();
});

test("the first turn of a task in To do moves it to In progress, and marks it started once", () => {
  const first = started(todo("a", "A"), 5);
  expect(first.startedAt).toBe(5);
  expect(first.task?.status).toBe("progress");
  const review = { ...first, task: { ...first.task!, status: "review" as const } };
  const again = started(review, 9);
  expect(again.startedAt).toBe(5);
  expect(again.task?.status).toBe("review");
});

describe("merging", () => {
  test("what the folded tasks cover joins the target, in order", () => {
    const { thread: next, added } = merged(todo("a", "A"), [todo("b", "B"), todo("c", "C")], 5);
    expect(next.task?.covers.map((item) => item.title)).toEqual(["A", "B", "C"]);
    expect(added.map((item) => item.title)).toEqual(["B", "C"]);
    expect(next.title).toBe("A");
  });

  test.each([
    [
      "a started task",
      todo("a", "A"),
      todo("b", "B", { startedAt: 1 }),
      "“B” has started, so it can't fold into another task.",
    ],
    [
      "a task from another project",
      todo("a", "A"),
      todo("b", "B", { projectId: "q" }),
      "“B” is in another project.",
    ],
    [
      "into a done task",
      todo("a", "A", { task: { status: "done", covers: [], movedAt: 0 } }),
      todo("b", "B"),
      "This task is done. Reopen it first.",
    ],
    [
      "into a chat",
      thread(),
      todo("b", "B"),
      "Only a task can take on more. Make this chat a task first.",
    ],
  ])("refuses %s", (_name, target, source, message) => {
    expect(() => merged(target, [source], 5)).toThrow(message);
  });
});

describe("splitting", () => {
  test("a task nobody started is named after the first item it keeps", () => {
    const { thread: two } = merged(todo("a", "A"), [todo("b", "B")], 1);
    const { thread: next, item } = split(two, "a-item", 5);
    expect(item.title).toBe("A");
    expect(next.title).toBe("B");
    expect(next.task?.covers.map((entry) => entry.title)).toEqual(["B"]);
  });

  test("a started task keeps its name and can give up its last item", () => {
    const task = todo("a", "A", { startedAt: 1, title: "Fix the reconnect test" });
    const { thread: next } = split(task, "a-item", 5);
    expect(next.title).toBe("Fix the reconnect test");
    expect(next.task?.covers).toEqual([]);
  });

  test("a task nobody started keeps its last item", () => {
    expect(() => split(todo("a", "A"), "a-item", 5)).toThrow(
      "It's the only thing this task covers.",
    );
  });
});
