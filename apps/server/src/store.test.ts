import { expect, test } from "vitest";
import type { Item, Thread } from "@dodocode/protocol";
import { Store } from "./store";

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
