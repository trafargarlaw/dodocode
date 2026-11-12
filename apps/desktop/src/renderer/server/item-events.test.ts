import { describe, expect, test } from "vitest";
import type { AssistantItem, Item, ToolItem } from "@dodocode/protocol";
import { applyItemEvents, type ItemEvent } from "./item-events";

const base = { threadId: "t", turnId: "turn", seq: 1, createdAt: 0 };
const assistant = (id: string, text: string): AssistantItem => ({
  ...base,
  id,
  type: "assistant",
  text,
  streaming: true,
});
const tool = (id: string, output: string): ToolItem => ({
  ...base,
  id,
  type: "tool",
  kind: "command",
  name: "Bash",
  title: "ls",
  input: {},
  output,
  status: "running",
});
const put = (item: Item): ItemEvent => ({ type: "item", threadId: "t", item });
const append = (itemId: string, field: "text" | "output", text: string): ItemEvent => ({
  type: "item.append",
  threadId: "t",
  itemId,
  field,
  text,
});

/** Each changed item's streamed field, by id. */
function streamed(changed: Map<string, Item>): Record<string, string> {
  return Object.fromEntries(
    [...changed].map(([id, item]) => [
      id,
      "output" in item ? item.output : (item as AssistantItem).text,
    ]),
  );
}

describe("applyItemEvents", () => {
  test.each<[string, Item[], ItemEvent[], Record<string, string>]>([
    [
      "appends to a held item",
      [assistant("a", "Hel")],
      [append("a", "text", "lo")],
      { a: "Hello" },
    ],
    [
      "appends in order to an item from the same events",
      [],
      [put(assistant("a", "")), append("a", "text", "Hi"), append("a", "text", "!")],
      { a: "Hi!" },
    ],
    [
      "appends a command's output",
      [tool("c", "one\n")],
      [append("c", "output", "two\n")],
      { c: "one\ntwo\n" },
    ],
    [
      "replaces a held item with the one sent",
      [assistant("a", "old")],
      [put(assistant("a", "new"))],
      { a: "new" },
    ],
    ["skips an append for an item it can't find", [], [append("b", "text", "x")], {}],
    [
      "skips an append to a field the item lacks",
      [assistant("a", "x")],
      [append("a", "output", "y")],
      {},
    ],
  ])("%s", (_name, held, events, expected) => {
    const map = new Map(held.map((item) => [item.id, item]));
    expect(streamed(applyItemEvents(map, events))).toEqual(expected);
  });

  test("leaves the held items as they were", () => {
    const held = new Map<string, Item>([["a", assistant("a", "Hel")]]);
    applyItemEvents(held, [append("a", "text", "lo")]);
    expect((held.get("a") as AssistantItem).text).toBe("Hel");
  });
});
