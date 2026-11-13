import { expect, test } from "vitest";
import type { Item } from "@dodocode/protocol";

import { History } from "../history";
import { CodexReader } from "./codex-sessions";

const said = (id: string, text: string) => ({
  type: "userMessage",
  id,
  content: [{ type: "text", text }],
});
const reply = (id: string, text: string) => ({ type: "agentMessage", id, text });

/** What a thread shows, one line per item. */
function shown(items: readonly Item[]): string[] {
  return items.map((item) => {
    switch (item.type) {
      case "user":
        return `${item.steered ? "steered" : "user"}: ${item.text}`;
      case "assistant":
        return `assistant: ${item.text}`;
      case "tool":
        return `tool ${item.title}: ${item.status}`;
      case "turn_end":
        return `end: ${item.status}${item.error ? ` (${item.error})` : ""}`;
      default:
        return item.type;
    }
  });
}

test("a Codex conversation reads turn by turn, with its subagent's work in a thread of its own", async () => {
  const turns: Record<string, unknown[]> = {
    main: [
      {
        id: "t1",
        status: "completed",
        startedAt: 100,
        completedAt: 110,
        items: [
          said("u1", "fix the bug"),
          reply("a1", "Looking."),
          // Sent while the agent worked.
          said("u2", "the one in the parser"),
          {
            type: "collabAgentToolCall",
            id: "c1",
            tool: "spawnAgent",
            prompt: "Find the parser\nand its tests",
            receiverThreadIds: ["child"],
            status: "completed",
          },
          reply("a2", "Fixed."),
        ],
      },
      // Started by the agent, and still going when it was read.
      { id: "t2", status: "inProgress", startedAt: 200, items: [reply("a3", "Tests pass.")] },
      {
        id: "t3",
        status: "failed",
        error: { message: "Rate limited." },
        startedAt: 300,
        completedAt: 305,
        items: [said("u3", "and the docs")],
      },
    ],
    // The subagent's thread does not hold the prompt it was started with.
    child: [{ id: "t4", status: "completed", items: [reply("a4", "In src/parse.ts.")] }],
  };
  const history = new History("thread", () => undefined);

  await new CodexReader(
    { turns: async (threadId) => turns[threadId] as never },
    history,
    "/work/app",
  ).thread("main", history.main);

  const items = history.main.finish();
  expect(shown(items)).toEqual([
    "user: fix the bug",
    "assistant: Looking.",
    "steered: the one in the parser",
    "tool Find the parser: done",
    "assistant: Fixed.",
    "end: completed",
    "assistant: Tests pass.",
    "end: interrupted",
    "user: and the docs",
    "end: failed (Rate limited.)",
  ]);
  const worked = items.flatMap((item) => (item.type === "turn_end" ? [item.durationMs] : []));
  expect(worked).toEqual([10_000, 0, 5_000]);

  expect(history.children.map((child) => child.title)).toEqual(["Find the parser"]);
  expect(shown(history.children[0]!.writer.finish())).toEqual([
    "user: Find the parser\nand its tests",
    "assistant: In src/parse.ts.",
    "end: completed",
  ]);
});
