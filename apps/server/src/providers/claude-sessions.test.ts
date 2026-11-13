import { describe, expect, test } from "vitest";
import type { Item, Question } from "@dodocode/protocol";

import { History } from "../history";
import { answersOf, ClaudeReader, type Line } from "./claude-sessions";

/** Builds a session's lines, each the child of the one before unless it names its parent. */
function session() {
  const lines: Line[] = [];
  let last: string | null = null;
  let second = 0;
  const push = (line: Line, parent?: string | null): string => {
    const uuid = `u${lines.length + 1}`;
    second += 1;
    lines.push({
      uuid,
      parentUuid: parent === undefined ? last : parent,
      timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, second)).toISOString(),
      ...line,
    });
    last = uuid;
    return uuid;
  };
  let message = 0;
  return {
    lines,
    prompt: (text: string, parent?: string | null, extra: Partial<Line> = {}) =>
      push({ type: "user", message: { content: text }, ...extra }, parent),
    reply: (content: unknown[], end = true, parent?: string) =>
      push(
        {
          type: "assistant",
          message: {
            id: `m${++message}`,
            model: "claude-opus-5-5",
            content,
            stop_reason: end ? "end_turn" : "tool_use",
          },
        },
        parent,
      ),
    result: (content: unknown[], toolUseResult?: unknown) =>
      push({ type: "user", message: { content }, toolUseResult }),
    line: (line: Line, parent?: string | null) => push(line, parent),
    /** Moves the session's time on. */
    wait: (seconds: number) => {
      second += seconds;
    },
  };
}

const text = (value: string) => ({ type: "text", text: value });
const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  type: "tool_use",
  id,
  name: "Bash",
  input: { command, ...extra },
});

function read(lines: Line[], subagents: Record<string, Line[]> = {}) {
  const history = new History("thread", () => undefined);
  const result = new ClaudeReader(
    history,
    { lines, subagent: (toolId) => subagents[toolId] },
    "/work/app",
  ).read();
  return { history, result, items: history.main.finish() };
}

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
      case "notice":
        return `notice: ${item.text}`;
      case "turn_end":
        return `end: ${item.status}`;
      default:
        return item.type;
    }
  });
}

describe("reading a Claude conversation", () => {
  test("it reads as the branch it ended on, across a compaction, without the app's own lines", () => {
    const s = session();
    s.prompt("first");
    const answered = s.reply([text("one")]);
    s.prompt("asked, then edited");
    s.reply([text("left behind")]);
    // The edited message, sent again from the same place.
    s.prompt("second", answered);
    // A skill's instructions, which the app adds after the prompt.
    s.prompt("Base directory for this skill: /skills/run", undefined, { isMeta: true });
    const before = s.reply([text("two")]);
    // The person comes back an hour later, and the next message sets off the compaction.
    s.wait(3600);
    s.line(
      {
        type: "system",
        subtype: "compact_boundary",
        logicalParentUuid: before,
        compactMetadata: { trigger: "auto", preTokens: 150_000, postTokens: 20_000 },
      },
      null,
    );
    s.prompt("This session is being continued from a previous conversation.", undefined, {
      isCompactSummary: true,
    });
    s.prompt("third");
    s.reply([text("three")]);

    const { items, result } = read(s.lines);

    expect(shown(items)).toEqual([
      "user: first",
      "assistant: one",
      "end: completed",
      "user: second",
      "assistant: two",
      "end: completed",
      "notice: Compacted the conversation by itself, from 150k to 20k tokens.",
      "user: third",
      "assistant: three",
      "end: completed",
    ]);
    // Each turn worked from its prompt to its reply: the hour away is in none of them.
    const worked = items.flatMap((item) => (item.type === "turn_end" ? [item.durationMs] : []));
    expect(worked).toEqual([1000, 2000, 1000]);
    expect(result.model).toBe("claude-opus-5-5");
  });

  test("a message sent while the agent worked goes into its turn, and one sent after starts the next", () => {
    const s = session();
    s.prompt("run the tests");
    s.reply([bash("t1", "pnpm test")], false);
    s.line({
      type: "attachment",
      attachment: { type: "queued_command", prompt: "only the server's", commandMode: "prompt" },
    });
    s.result([{ type: "tool_result", tool_use_id: "t1", content: "ok" }]);
    s.reply([text("They pass.")]);
    s.line({
      type: "attachment",
      attachment: { type: "queued_command", prompt: "now the app's", commandMode: "prompt" },
    });
    s.reply([text("Those pass too.")]);

    expect(shown(read(s.lines).items)).toEqual([
      "user: run the tests",
      "tool pnpm test: done",
      "steered: only the server's",
      "assistant: They pass.",
      "end: completed",
      "user: now the app's",
      "assistant: Those pass too.",
      "end: completed",
    ]);
  });

  test("a turn the person stopped ends interrupted, with the call they declined", () => {
    const s = session();
    s.prompt("delete the build folder");
    s.reply([bash("t1", "rm -rf build")], false);
    s.result([
      {
        type: "tool_result",
        tool_use_id: "t1",
        is_error: true,
        content: "The user doesn't want to proceed with this tool use.",
      },
      text("[Request interrupted by user for tool use]"),
    ]);
    s.prompt("keep it");
    s.reply([text("Kept.")]);

    expect(shown(read(s.lines).items)).toEqual([
      "user: delete the build folder",
      "tool rm -rf build: denied",
      "end: interrupted",
      "user: keep it",
      "assistant: Kept.",
      "end: completed",
    ]);
  });

  test("a background task's news finishes its call and starts a turn of the agent's own", () => {
    const s = session();
    s.prompt("start the server");
    s.reply([bash("t1", "pnpm dev", { run_in_background: true })], false);
    s.result([{ type: "tool_result", tool_use_id: "t1", content: "Started b1" }], {
      backgroundTaskId: "b1",
    });
    s.reply([text("It is starting.")]);
    s.prompt(
      "<task-notification><tool-use-id>t1</tool-use-id><status>completed</status></task-notification>",
      undefined,
      { turnOrigin: "task_notification" },
    );
    s.reply([text("It is up.")]);

    const { items } = read(s.lines);
    expect(shown(items)).toEqual([
      "user: start the server",
      "tool pnpm dev: done",
      "assistant: It is starting.",
      "end: completed",
      "assistant: It is up.",
      "end: completed",
    ]);
    // Done when the news came, the fifth line.
    const tool = items.find((item) => item.type === "tool");
    expect(tool?.type === "tool" && tool.endedAt).toBe(Date.UTC(2026, 0, 1, 0, 0, 5));
  });

  test("a subagent's work reads into a thread of its own, under the call that started it", () => {
    const s = session();
    s.prompt("look into it");
    s.reply(
      [
        {
          type: "tool_use",
          id: "a1",
          name: "Agent",
          input: { description: "Find the parser", prompt: "Where is the parser?" },
        },
      ],
      false,
    );
    s.result([{ type: "tool_result", tool_use_id: "a1", content: "In src/parse.ts" }], {
      agentId: "x1",
    });
    s.reply([text("Found it.")]);
    const sub = session();
    sub.prompt("Where is the parser?", null, { isSidechain: true });
    sub.line({
      type: "assistant",
      isSidechain: true,
      message: { id: "s1", content: [text("In src/parse.ts")], stop_reason: "end_turn" },
    });

    const { history, items } = read(s.lines, { a1: sub.lines });

    expect(history.children.map((child) => child.title)).toEqual(["Find the parser"]);
    const child = history.children[0]!.writer;
    expect(shown(child.finish())).toEqual([
      "user: Where is the parser?",
      "assistant: In src/parse.ts",
      "end: completed",
    ]);
    const tool = items.find((item) => item.type === "tool");
    expect(tool?.type === "tool" && tool.childThreadId).toBe(child.threadId);
  });
});

const question = (multiSelect: boolean, labels: string[]): Question => ({
  id: "0",
  header: "",
  question: "Which?",
  options: labels.map((label) => ({ label })),
  multiSelect,
});

describe("answers to a question", () => {
  test.each([
    { multi: false, labels: ["Red", "Blue"], answer: "Red", answers: ["Red"] },
    { multi: true, labels: ["Red", "Blue"], answer: "Red, Blue", answers: ["Red", "Blue"] },
    // A label with a comma in it is one answer.
    {
      multi: true,
      labels: ["Red, mostly", "Blue"],
      answer: "Red, mostly",
      answers: ["Red, mostly"],
    },
    // Words of the person's own, which name no label.
    {
      multi: true,
      labels: ["Red", "Blue"],
      answer: "Red, then green",
      answers: ["Red, then green"],
    },
  ])("$answer → $answers", ({ multi, labels, answer, answers }) => {
    expect(answersOf([question(multi, labels)], { "Which?": answer })).toEqual({ "0": answers });
  });
});
