import { expect, test } from "vitest";

import { moveTask, moveTaskTitle } from "./app-tools";
import type { AgentMove, SessionHost } from "./types";

/** A host whose board takes any move but a chat outside a project's. */
function host(project: boolean) {
  const moves: AgentMove[] = [];
  const fake = {
    moveTask: (status: AgentMove) => {
      if (!project) throw new Error("Only a thread in a project can be a task.");
      moves.push(status);
      return `Moved it to ${status}.`;
    },
  } as Pick<SessionHost, "moveTask"> as SessionHost;
  return { fake, moves };
}

test("the agent hears whether its task moved, and why not", () => {
  const board = host(true);
  expect(moveTask(board.fake, { status: "review" })).toEqual({
    ok: true,
    text: "Moved it to review.",
  });
  // Only the person puts work in To do.
  expect(moveTask(board.fake, { status: "todo" })).toEqual({
    ok: false,
    text: "status must be progress, review or done.",
  });
  expect(board.moves).toEqual(["review"]);

  expect(moveTask(host(false).fake, { status: "done" })).toEqual({
    ok: false,
    text: "Only a thread in a project can be a task.",
  });
});

test("a move shows in the thread under the column's name", () => {
  expect(moveTaskTitle({ status: "review" })).toBe("Move this task to In review");
  expect(moveTaskTitle({})).toBe("Move this task");
});
