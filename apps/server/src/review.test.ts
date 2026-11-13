import { describe, expect, test } from "vitest";
import { taskPrompt, type Finding, type Review } from "@dodocode/protocol";

import { answered, decided, findingsMessage, reported, reviewPrompt } from "./review";

function review(findings: Finding[] = [], fields: Partial<Review> = {}): Review {
  return { base: "abc1234def5678", baseLabel: "main", findings, ...fields };
}

function finding(id: string, fields: Partial<Finding> = {}): Finding {
  return { id, group: "Standards", kind: "violation", summary: `Problem ${id}`, ...fields };
}

describe("reporting", () => {
  test("a review keeps what its reviewer found, each finding with an id of its own", () => {
    const next = reported(
      review(),
      [
        { group: "Standards", kind: "violation", summary: "Uses any", file: "a.ts", line: 3 },
        { group: "Spec", kind: "missing", summary: "No empty state" },
      ],
      7,
    );
    expect(next.reportedAt).toBe(7);
    expect(next.findings.map(({ id: _id, ...rest }) => rest)).toEqual([
      { group: "Standards", kind: "violation", summary: "Uses any", file: "a.ts", line: 3 },
      { group: "Spec", kind: "missing", summary: "No empty state" },
    ]);
    expect(new Set(next.findings.map((entry) => entry.id)).size).toBe(2);
  });

  test("once the findings went to the task, the review takes no more", () => {
    expect(() => reported(review([], { sentAt: 5 }), [], 7)).toThrow(
      "The findings went to the task's agent already.",
    );
  });

  test("the task's agent gets each finding under its axis, axes in the order reported", () => {
    const message = findingsMessage(
      review([
        finding("f1", { group: "Spec", kind: "missing", summary: "No empty state" }),
        finding("f2", { file: "src/a.ts", line: 3, summary: "Uses any", quote: "x: any" }),
        finding("f3", { group: "Spec", kind: "looks wrong", summary: "Sorts the wrong way" }),
      ]),
    );
    expect(message.slice(message.indexOf("## "))).toBe(
      [
        "## Spec",
        "",
        "- **f1** · missing: No empty state",
        "- **f3** · looks wrong: Sorts the wrong way",
        "",
        "## Standards",
        "",
        "- **f2** · violation (src/a.ts:3): Uses any",
        "  > x: any",
      ].join("\n"),
    );
  });
});

describe("answering", () => {
  test("each answer goes into its finding, in whichever review, and an unknown id is refused", () => {
    const older = review([finding("f1"), finding("f2")]);
    const untouched = review([finding("f4")]);
    const next = answered(
      [older, review([finding("f3")]), untouched],
      [
        { id: "f1", outcome: "fixed", note: " Typed it. " },
        { id: "f3", outcome: "disputed", note: "The API returns any." },
      ],
    );
    expect(next.map((entry) => entry.findings.map((item) => item.answer))).toEqual([
      [{ outcome: "fixed", note: "Typed it." }, undefined],
      [{ outcome: "disputed", note: "The API returns any." }],
      [undefined],
    ]);
    expect(next[2]).toBe(untouched);
    expect(() => answered(next, [{ id: "f9", outcome: "fixed", note: "" }])).toThrow(
      "f9 is not a finding of a review sent to you. Their findings are f1, f2, f3, f4.",
    );
  });

  test.each([
    ["fixed", "fix"],
    ["disputed", undefined],
  ] as const)(
    "a finding sent back to be fixed anyway, answered %s, keeps the person's call: %s",
    (outcome, decision) => {
      const sentBack = finding("f1", {
        answer: { outcome: "disputed", note: "Intended." },
        decision: "fix",
      });
      const [next] = answered([review([sentBack])], [{ id: "f1", outcome, note: "Again." }]);
      expect(next?.findings[0]?.decision).toBe(decision);
    },
  );

  test("only a finding the agent disputed takes the person's call", () => {
    const disputed = finding("f1", { answer: { outcome: "disputed", note: "Intended." } });
    const fixed = finding("f2", { answer: { outcome: "fixed", note: "Done." } });
    const next = decided(review([disputed, fixed]), "f1", "agree");
    expect(next.findings.map((entry) => entry.decision)).toEqual(["agree", undefined]);
    expect(() => decided(next, "f2", "fix")).toThrow(
      "Only a finding the agent disputed waits for your call.",
    );
  });
});

describe("the reviewer's brief", () => {
  const covers = [{ id: "i1", title: "Add dark mode" }];

  test("the spec is what the person asked for, the task's own brief not repeated", () => {
    const prompt = reviewPrompt({
      title: "Add dark mode",
      base: "abc1234def5678",
      baseLabel: "main",
      covers,
      messages: [`${taskPrompt(covers)}\n\nKeep the toggle in settings.`, "Also the sidebar."],
    });
    const spec = prompt.slice(prompt.indexOf("## The spec"), prompt.indexOf("## How to review"));
    expect(spec.split("Add dark mode").length - 1).toBe(1);
    expect(spec).toContain("- Keep the toggle in settings.\n- Also the sidebar.");
    expect(prompt).toContain("`git diff abc1234def56`");
  });

  test("a project's own way of reviewing replaces the built-in one", () => {
    const brief = { title: "T", base: "abc", baseLabel: "main", covers, messages: [] };
    const own = reviewPrompt({
      ...brief,
      method: { path: "docs/review.md", text: "Check the migrations.\n" },
    });
    expect(own).toContain(
      "This project reviews its own way, as `docs/review.md` says:\n\nCheck the migrations.",
    );
    expect(own).not.toContain("Review along two axes");
    expect(reviewPrompt(brief)).toContain("Review along two axes");
  });
});
