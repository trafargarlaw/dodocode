import { describe, expect, test } from "vitest";
import type { TaskStatus, Thread, ThreadStatus } from "@dodocode/protocol";
import {
  boardColumns,
  CHAT_AGE_MS,
  dropOf,
  reviewable,
  sidebarGroups,
  topThreadId,
  type ListFilter,
} from "./task-list";

function thread(id: string, fields: Partial<Thread> = {}): Thread {
  return {
    id,
    projectId: "p",
    kind: fields.parentId ? "subagent" : "main",
    title: id,
    status: "idle",
    settings: { provider: "claude", model: "m", effort: "", access: "supervised" },
    createdAt: 0,
    updatedAt: 0,
    activityAt: 0,
    startedAt: 0,
    ...fields,
  };
}

function task(id: string, status: TaskStatus, fields: Partial<Thread> = {}): Thread {
  return thread(id, { task: { status, covers: [], movedAt: 0 }, ...fields });
}

function sub(id: string, parentId: string, status: ThreadStatus = "idle"): Thread {
  return thread(id, { parentId, status });
}

const ALL: ListFilter = { needsYou: false };

const ids = (cards: Thread[]) => cards.map((card) => card.id);

/**
 * The groups as `group: rows`, and the count behind "Show more". A row whose mark shows another
 * status than its thread's own, from a subagent, says which.
 */
function groups(
  threads: Thread[],
  {
    openId,
    filter = ALL,
    limit = 5,
    now = 0,
  }: Partial<{
    openId: string;
    filter: ListFilter;
    limit: number;
    now: number;
  }> = {},
) {
  return sidebarGroups(threads, { openId, filter, limit, now }).map((group) => {
    const rows = group.rows.map((row) =>
      row.status === row.thread.status ? row.thread.id : `${row.thread.id} (${row.status})`,
    );
    return `${group.id}: ${rows.join(", ")}${group.hidden ? ` +${group.hidden}` : ""}`;
  });
}

describe("the sidebar", () => {
  test("groups the tasks by where each is, then the chats, then done, and leaves out empty groups", () => {
    const list = [thread("chat"), task("t", "todo"), task("p", "progress"), task("d", "done")];
    expect(groups(list)).toEqual(["progress: p", "todo: t", "chats: chat", "done: d"]);
  });

  test("puts pinned threads first, then what waits for the person, then the newest", () => {
    const list = [
      task("new", "progress", { activityAt: 9 }),
      task("waiting", "progress", { status: "waiting", activityAt: 1 }),
      task("pinned", "progress", { pinned: true, activityAt: 0 }),
      task("old", "progress", { activityAt: 2 }),
    ];
    expect(groups(list)).toEqual(["progress: pinned, waiting, new, old"]);
  });

  test("lists done tasks by when they finished", () => {
    const list = [
      task("early", "done", { task: { status: "done", covers: [], movedAt: 1 }, activityAt: 9 }),
      task("late", "done", { task: { status: "done", covers: [], movedAt: 5 }, activityAt: 0 }),
    ];
    expect(groups(list)).toEqual(["done: late, early"]);
  });

  test.each<[string, Thread[], Parameters<typeof groups>[1], string[]]>([
    [
      "shows a group's top threads up to the limit",
      [thread("a"), thread("b"), thread("c")],
      { limit: 2 },
      ["chats: a, b +1"],
    ],
    [
      "shows the open thread past the limit",
      [thread("a"), thread("b"), thread("c")],
      { limit: 2, openId: "c" },
      ["chats: a, b, c"],
    ],
    [
      "hides a chat left for a week, unless it's pinned",
      [thread("old"), thread("kept", { pinned: true }), thread("new", { activityAt: CHAT_AGE_MS })],
      { now: CHAT_AGE_MS + 1 },
      ["chats: kept, new +1"],
    ],
    [
      "keeps a task in To do however old",
      [task("old", "todo")],
      { now: CHAT_AGE_MS * 4 },
      ["todo: old"],
    ],
    [
      "hides archived threads, unless open",
      [thread("a", { archived: true }), thread("b", { archived: true })],
      { openId: "b" },
      ["chats: b"],
    ],
    [
      "shows one project's threads, and none without a project",
      [thread("a"), thread("b", { projectId: "q" }), thread("c", { projectId: undefined })],
      { filter: { projectId: "q", needsYou: false } },
      ["chats: b"],
    ],
    [
      "shows what needs the person, through a subagent too",
      [thread("a", { status: "error" }), thread("b"), thread("c"), sub("s", "c", "waiting")],
      { filter: { needsYou: true } },
      ["chats: a, c (waiting)"],
    ],
    [
      "lists top threads only, the open thread's subagents too",
      [sub("s", "a", "running"), thread("a", { activityAt: 1 }), thread("b")],
      { openId: "a" },
      ["chats: a (running), b"],
    ],
    [
      "shows the top thread of an open subagent's subagent past the limit",
      [thread("a"), thread("b"), thread("c"), sub("s1", "c"), sub("s2", "s1")],
      { limit: 2, openId: "s2" },
      ["chats: a, b, c"],
    ],
    [
      "marks a thread waiting while its subagent waits, over its own error",
      [thread("a", { status: "error" }), sub("s", "a", "waiting"), sub("r", "a", "running")],
      {},
      ["chats: a (waiting)"],
    ],
    [
      "leaves a subagent's error in its own thread",
      [thread("a"), sub("s", "a", "error")],
      {},
      ["chats: a"],
    ],
    [
      "lists a subagent whose parent is gone as a top thread",
      [sub("s", "gone"), thread("a")],
      {},
      ["chats: s, a"],
    ],
  ])("%s", (_name, list, options, expected) => {
    expect(groups(list, options)).toEqual(expected);
  });

  test.each<[string, string, string | undefined]>([
    ["a top thread stands for itself", "a", "a"],
    ["a subagent's subagent belongs to the top thread", "s2", "a"],
    ["a thread not in the list belongs to none", "gone", undefined],
  ])("%s", (_name, threadId, expected) => {
    const list = [thread("a"), sub("s1", "a"), sub("s2", "s1")];
    expect(topThreadId(list, threadId)).toBe(expected);
  });
});

test("the board holds the tasks of the filter, not chats, and keeps archived ideas apart", () => {
  const list = [
    thread("chat"),
    task("idea", "backlog", { startedAt: undefined }),
    task("old", "backlog", { startedAt: undefined, archived: true, updatedAt: 1 }),
    task("dropped", "backlog", { startedAt: undefined, archived: true, updatedAt: 2 }),
    task("a", "todo"),
    task("b", "review"),
    task("gone", "review", { archived: true }),
    task("other", "todo", { projectId: "q" }),
  ];
  const columns = boardColumns(list, { projectId: "p", needsYou: false });
  expect({
    backlog: ids(columns.backlog),
    todo: ids(columns.todo),
    progress: ids(columns.progress),
    review: ids(columns.review),
    done: ids(columns.done),
    notDoing: ids(columns.notDoing),
  }).toEqual({
    backlog: ["idea"],
    todo: ["a"],
    progress: [],
    review: ["b"],
    done: [],
    notDoing: ["dropped", "old"],
  });
});

describe("dropping a card", () => {
  const fresh = task("fresh", "todo", { startedAt: undefined });
  const started = task("started", "todo");
  const review = task("review", "review");
  const idea = task("idea", "backlog", { startedAt: undefined });

  test.each<[string, Thread, TaskStatus | Thread, ReturnType<typeof dropOf>]>([
    ["on its own column does nothing", review, "review", { kind: "none" }],
    ["nobody started, on In progress, starts it", fresh, "progress", { kind: "start" }],
    [
      "started, on In progress, moves it",
      started,
      "progress",
      { kind: "move", status: "progress" },
    ],
    [
      "nobody started, on another task, folds it in",
      fresh,
      review,
      { kind: "merge", into: review },
    ],
    [
      "started, on another task, moves it to that column",
      started,
      review,
      { kind: "move", status: "review" },
    ],
    [
      "on a task that is done, moves it to Done",
      fresh,
      task("d", "done"),
      { kind: "move", status: "done" },
    ],
    [
      "on a task from another project, moves it",
      fresh,
      task("q", "review", { projectId: "q" }),
      { kind: "move", status: "review" },
    ],
    ["on itself does nothing", fresh, fresh, { kind: "none" }],
    ["an idea, on To do, plans it", idea, "todo", { kind: "move", status: "todo" }],
    [
      "nobody started, on the backlog, unplans it",
      fresh,
      "backlog",
      { kind: "move", status: "backlog" },
    ],
    ["started, on the backlog, does nothing", started, "backlog", { kind: "none" }],
    ["an idea, on a task, folds it in", idea, review, { kind: "merge", into: review }],
    [
      "planned, on an idea, moves it to the backlog",
      fresh,
      idea,
      { kind: "move", status: "backlog" },
    ],
  ])("%s", (_name, card, target, expected) => {
    expect(dropOf(card, target)).toEqual(expected);
  });
});

test.each([
  ["a task under way", task("a", "progress"), true],
  ["a task in review", task("a", "review"), true],
  ["a task nobody started", task("a", "todo", { startedAt: undefined }), false],
  ["a task done", task("a", "done"), false],
  [
    "a task whose work is merged",
    task("a", "review", {
      worktree: { path: "w", workDir: "w", branch: "b", from: "c", mergedAt: 5 },
    }),
    false,
  ],
  ["a chat", thread("a"), false],
])("%s can be reviewed: %s", (_name, card, can) => {
  expect(reviewable(card)).toBe(can);
});
