import { expect, test } from "vitest";
import type { Item, Thread } from "@dodocode/protocol";
import { Store, type ResumePoints } from "./store";

function thread(id: string, parentId?: string): Thread {
  return {
    id,
    projectId: "p",
    parentId,
    kind: parentId ? "subagent" : "main",
    title: id,
    status: "idle",
    settings: { provider: "claude", model: "m", effort: "", access: "supervised" },
    createdAt: 0,
    updatedAt: 0,
    activityAt: 0,
  };
}

test("deleting a thread deletes its subagents' threads and theirs, with their items", () => {
  const store = new Store(":memory:");
  for (const each of [thread("a"), thread("s1", "a"), thread("s2", "s1"), thread("b")]) {
    store.saveThread(each);
  }
  const item: Item = {
    id: "i",
    threadId: "s2",
    turnId: "turn",
    seq: 1,
    createdAt: 0,
    type: "assistant",
    text: "done",
    streaming: false,
  };
  store.saveItem(item);

  store.deleteThread("a");

  expect(store.threads().map((each) => each.id)).toEqual(["b"]);
  expect(store.items("s2")).toEqual([]);
});

test("a thread saved before costs were kept still resumes its sessions", () => {
  const store = new Store(":memory:");
  store.saveThread(thread("a"));
  // As it was saved then: the session's id alone.
  store.saveResumePoints("a", { claude: "s1" } as unknown as ResumePoints);
  expect(store.resumePoints("a")).toEqual({ claude: { id: "s1" } });

  store.saveResumePoints("a", { claude: { id: "s1", costUsd: 1.5 }, codex: { id: "c1" } });
  expect(store.resumePoints("a")).toEqual({
    claude: { id: "s1", costUsd: 1.5 },
    codex: { id: "c1" },
  });
});

test("the sessions threads pick up stay dodocode's once the threads go, but for one from another app", () => {
  const store = new Store(":memory:");
  for (const id of ["a", "b"]) store.saveThread(thread(id));
  store.saveThread(carryingOn("c", "o1"));
  store.saveResumePoints("a", { claude: "s1" } as unknown as ResumePoints);
  store.saveResumePoints("b", { claude: { id: "s2", costUsd: 0.5 }, codex: { id: "c1" } });
  store.saveResumePoints("c", { claude: { id: "o1" } });
  expect([...store.ownSessions()].toSorted()).toEqual([
    "claude:o1",
    "claude:s1",
    "claude:s2",
    "codex:c1",
  ]);

  store.deleteThread("b");
  store.deleteThread("c");
  expect([...store.ownSessions()].toSorted()).toEqual(["claude:s1", "claude:s2", "codex:c1"]);
});

test("the sessions a thread lets go of stay dodocode's, but for one from another app", () => {
  const store = new Store(":memory:");
  store.saveThread(thread("a"));
  store.saveThread(carryingOn("c", "o1"));
  store.saveResumePoints("a", { claude: { id: "s1" }, codex: { id: "c1" } });
  store.saveResumePoints("c", { claude: { id: "o1" } });
  // A new Claude session, its cost as it goes up, then none at all, as after a merge.
  store.saveResumePoints("a", { claude: { id: "s2" }, codex: { id: "c1" } });
  store.saveResumePoints("a", { claude: { id: "s2", costUsd: 0.5 }, codex: { id: "c1" } });
  store.saveResumePoints("a", {});
  store.saveResumePoints("c", {});

  expect([...store.ownSessions()].toSorted()).toEqual(["claude:s1", "claude:s2", "codex:c1"]);
});

/** A thread brought in from Claude Code that carries on the same conversation, `sessionId`. */
function carryingOn(id: string, sessionId: string): Thread {
  return {
    ...thread(id),
    origin: {
      provider: "claude",
      app: "Claude Code",
      sessionId,
      cwd: "/work",
      mode: "same",
      broughtAt: 0,
    },
  };
}
