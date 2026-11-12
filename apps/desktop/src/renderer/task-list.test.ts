import { describe, expect, test } from "vitest";
import type { TaskStatus, Thread, ThreadStatus } from "@dodocode/protocol";
import { boardColumns, CHAT_AGE_MS, dropOf, sidebarGroups, type ListFilter } from "./task-list";

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

/** The groups as `group: rows`, a nested row indented, and the count behind "Show more". */
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
    const rows = group.rows.map((row) => (row.nested ? `  ${row.thread.id}` : row.thread.id));
    return `${group.id}: ${rows.join(", ")}${group.hidden ? ` +${group.hidden}` : ""}`;
  });
}

describe("the sidebar", () => {
  test("groups threads by where their task is, chats apart, and leaves out empty groups", () => {
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
      ["chats: a, c,   s"],
    ],
  ])("%s", (_name, list, options, expected) => {
    expect(groups(list, options)).toEqual(expected);
  });

  test.each<[string, Thread[], string | undefined, string[]]>([
    [
      "nests a subagent under the open thread",
      [sub("s", "a"), thread("a"), thread("b")],
      "a",
      ["chats: a,   s, b"],
    ],
    [
      "hides an idle subagent of a closed thread",
      [sub("s", "a"), thread("a"), thread("b")],
      "b",
      ["chats: a, b"],
    ],
    [
      "shows a running subagent of a closed thread",
      [sub("s", "a", "running"), thread("a"), thread("b")],
      "b",
      ["chats: a,   s, b"],
    ],
    [
      "nests a subagent's subagent under the top thread",
      [sub("s2", "s1"), sub("s1", "a"), thread("a")],
      "s2",
      ["chats: a,   s2,   s1"],
    ],
    [
      "lists a subagent whose parent is gone as a top thread",
      [sub("s", "gone"), thread("a")],
      undefined,
      ["chats: s, a"],
    ],
  ])("%s", (_name, list, openId, expected) => {
    expect(groups(list, { openId })).toEqual(expected);
  });
});

test("the board holds the tasks of the filter, not chats or archived ones", () => {
  const list = [
    thread("chat"),
    task("a", "todo"),
    task("b", "review"),
    task("gone", "review", { archived: true }),
    task("other", "todo", { projectId: "q" }),
  ];
  const columns = boardColumns(list, { projectId: "p", needsYou: false });
  expect(Object.values(columns).map((column) => column.map((card) => card.id))).toEqual([
    ["a"],
    [],
    ["b"],
    [],
  ]);
});

describe("dropping a card", () => {
  const fresh = task("fresh", "todo", { startedAt: undefined });
  const started = task("started", "todo");
  const review = task("review", "review");

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
  ])("%s", (_name, card, target, expected) => {
    expect(dropOf(card, target)).toEqual(expected);
  });
});
