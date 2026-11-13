import { describe, expect, test } from "vitest";

import { addIdea, answerFindingsTitle, moveTask, moveTaskTitle, runAppTool } from "./app-tools";
import type {
  AgentMove,
  FindingAnswerRequest,
  FindingReport,
  IdeaRequest,
  SessionHost,
} from "./types";

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

test("an idea reaches the backlog with its title and details, and needs a title", () => {
  const ideas: IdeaRequest[] = [];
  const fake = {
    addIdea: (idea: IdeaRequest) => {
      ideas.push(idea);
      return `Added “${idea.title}”.`;
    },
  } as Pick<SessionHost, "addIdea"> as SessionHost;
  expect(addIdea(fake, { title: "Fix the flaky test", details: "It times out." })).toEqual({
    ok: true,
    text: "Added “Fix the flaky test”.",
  });
  expect(addIdea(fake, { title: "  " })).toEqual({ ok: false, text: "Give the idea a title." });
  expect(ideas).toEqual([{ title: "Fix the flaky test", details: "It times out." }]);

  const noBoard = {
    addIdea: () => {
      throw new Error("This conversation has no project, so there is no board to add it to.");
    },
  } as Pick<SessionHost, "addIdea"> as SessionHost;
  expect(addIdea(noBoard, { title: "Fix it" })).toEqual({
    ok: false,
    text: "This conversation has no project, so there is no board to add it to.",
  });
});

test("a move shows in the thread under the column's name", () => {
  expect(moveTaskTitle({ status: "review" })).toBe("Move this task to In review");
  expect(moveTaskTitle({})).toBe("Move this task");
});

/** A host that keeps what it is given, as a reviewer or as the task's agent. */
function reviewHost(reviewing: boolean) {
  const kept: { findings?: FindingReport[]; answers?: FindingAnswerRequest[] } = {};
  const fake = {
    reviewing,
    moveTask: (status: AgentMove) => `Moved it to ${status}.`,
    reportFindings: (findings: FindingReport[]) => {
      kept.findings = findings;
      return `Kept ${findings.length}.`;
    },
    answerFindings: (answers: FindingAnswerRequest[]) => {
      kept.answers = answers;
      return `Recorded ${answers.length}.`;
    },
  } as Pick<SessionHost, "reviewing" | "moveTask" | "reportFindings" | "answerFindings">;
  return { fake: fake as SessionHost, kept };
}

describe("review tools", () => {
  test("a reviewer reports findings but can't move the task; the task's agent the other way", () => {
    const reviewer = reviewHost(true);
    expect(runAppTool(reviewer.fake, "move_task", { status: "done" })).toEqual({
      ok: false,
      text: "dodocode has no tool named move_task.",
    });
    expect(runAppTool(reviewer.fake, "report_findings", { findings: [] })).toEqual({
      ok: true,
      text: "Kept 0.",
    });

    const worker = reviewHost(false);
    expect(runAppTool(worker.fake, "report_findings", { findings: [] })).toEqual({
      ok: false,
      text: "dodocode has no tool named report_findings.",
    });
    expect(runAppTool(worker.fake, "move_task", { status: "done" })).toEqual({
      ok: true,
      text: "Moved it to done.",
    });
  });

  test("findings are kept trimmed, and one with nothing to say is dropped", () => {
    const reviewer = reviewHost(true);
    runAppTool(reviewer.fake, "report_findings", {
      findings: [
        { group: " Spec ", kind: " missing ", summary: " No empty state ", line: 4 },
        { group: "Spec", kind: "missing", summary: "   " },
      ],
    });
    expect(reviewer.kept.findings).toEqual([
      { group: "Spec", kind: "missing", summary: "No empty state", line: 4 },
    ]);
  });

  test("the task's agent answers with at least one answer, and its title counts them", () => {
    const worker = reviewHost(false);
    expect(runAppTool(worker.fake, "answer_findings", { answers: [] }).ok).toBe(false);
    const answers = [
      { id: "f1", outcome: "fixed", note: "Typed it." },
      { id: "f2", outcome: "disputed", note: "Intended." },
      { id: "f3", outcome: "fixed", note: "Done." },
    ];
    expect(runAppTool(worker.fake, "answer_findings", { answers })).toEqual({
      ok: true,
      text: "Recorded 3.",
    });
    expect(worker.kept.answers).toEqual(answers);
    expect(answerFindingsTitle({ answers })).toBe("Answer the review: 2 fixed, 1 disputed");
  });
});
