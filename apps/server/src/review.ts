// A task's review: what the reviewer is asked, and how its findings go to the task's agent and
// come back answered. The app supplies what to review and the spec; the method, how to review,
// is built in, or a project's own Markdown file.

import { itemText, taskPrompt, type Finding, type Review, type TaskItem } from "@dodocode/protocol";

import type { FindingAnswerRequest, FindingReport } from "./providers/types";
import { newId } from "./util";

/**
 * The built-in way to review: two axes, Standards and Spec, each in a sub-agent of its own, never
 * ranked against each other.
 */
export const BUILT_IN_METHOD = `Review along two axes:

- **Standards**: does the code conform to this repo's documented coding standards?
- **Spec**: does the code faithfully implement what the spec above asked for?

Run both axes as **parallel sub-agents** so they don't pollute each other's context, then aggregate their findings. Start every sub-agent with a fresh context window. If you can't start sub-agents, do the Standards review first and finish it, then the Spec review, and keep them apart.

### 1. Identify the standards sources

Search the repo for every file that documents how code should be written. When \`CODING_STANDARDS.md\` or \`CONTRIBUTING.md\` exists, it must be on the list.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below: a fixed set of Fowler code smells (*Refactoring*, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation. Like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name**: a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code**: the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy**: a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps**: the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession**: a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches**: the same \`switch\`/\`if\`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery**: one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change**: one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality**: abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains**: long \`a.b().c().d()\` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man**: a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest**: a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 2. Spawn both sub-agents in parallel

Issue both sub-agent calls together, in the foreground, and aggregate the reports they return.

**Standards sub-agent prompt** should include:

- The commands that show the changes, and the commit list.
- The list of standards-source files you found in step 1, **plus the smell baseline from step 1** pasted in full (the sub-agent has no other access to it).
- The brief: "Report, per file/hunk where relevant, (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls: documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** should include:

- The commands that show the changes, and the commit list.
- The spec, in full.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If there is no spec, skip the Spec sub-agent and note this in the final report.

### 3. Aggregate

Report every finding with report_findings, its group \`Standards\` or \`Spec\`, and its kind:

- Standards: \`violation\` (breaks a documented standard; quote the rule and name its file) or \`judgement call\` (every baseline smell, named, as in "possible Feature Envy").
- Spec: \`missing\` (asked for, missing or partial), \`not asked for\` (scope creep), or \`looks wrong\` (implemented, but wrongly). Quote the spec line.

Then present the two reports under \`## Standards\` and \`## Spec\` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings, because the two axes are deliberately separate (see *Why two axes*).

End with a one-line summary: total findings per axis, and the worst issue *within each axis* (if any). Don't pick a single winner across axes: that's the reranking the separation exists to prevent.

### Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.`;

/** The longest a message of the person's goes into the spec. */
const MESSAGE_LIMIT = 6000;

/** What the reviewer needs to know, which the app works out before the review starts. */
export interface ReviewBrief {
  /** The task's title. */
  title: string;
  /** The commit the work is compared with. */
  base: string;
  /** How the person knows the base: a branch, or a short commit. */
  baseLabel: string;
  /** The branch the work is on, when it has one of its own. */
  branch?: string;
  /** What the task covers, in the person's words. */
  covers: readonly TaskItem[];
  /** What the person wrote in the task's thread, oldest first. */
  messages: readonly string[];
  /** The project's own way to review, from its Markdown file. Unset: the built-in way. */
  method?: { path: string; text: string };
}

/** The first message of a review: what to review, against what, and how. */
export function reviewPrompt(brief: ReviewBrief): string {
  const short = brief.base.slice(0, 12);
  const where = brief.branch ? ` on the branch \`${brief.branch}\`` : "";
  const lines = [
    `Review the work done on the task “${brief.title}”${where}. You only read and report: don't change any file, don't commit, and don't fix what you find. The agent that did the work answers your findings.`,
    "",
    "## The changes",
    "",
    `They are everything that differs from ${brief.baseLabel} (commit \`${short}\`), work not yet committed included:`,
    "",
    `- \`git diff ${short}\` shows them: it compares the files as they are now with that commit.`,
    "- `git status --short` lists new files git doesn't track yet (marked `??`). They are part of the work: read them whole.",
    `- \`git log --oneline ${short}..HEAD\` lists the commits, if the work made any.`,
    "",
    `Run these first. If they show nothing, report no findings and say there was nothing to review.`,
    "",
    "## The spec",
    "",
    specText(brief),
    "",
    "Also look for issue references in the commit messages (`#123`, `Closes #45`); when the `gh` CLI works here, read them with `gh issue view <number>`. Look too for a spec file under `docs/`, `specs/` or `.scratch/` that matches the branch name or the feature.",
    "",
    "## How to review",
    "",
    brief.method
      ? `This project reviews its own way, as \`${brief.method.path}\` says:\n\n${brief.method.text.trim()}`
      : BUILT_IN_METHOD,
    "",
    "## Reporting",
    "",
    "When you're done, call report_findings once with every finding, and with none when you found nothing. Each finding is about one thing, so it can be fixed or answered on its own: its group (the axis or part of the review it came from), its kind, what is wrong, the file and line when it is in one, and the code, rule or request it rests on, word for word. The agent that did the work fixes each finding or says why it is as intended; the person sees both.",
    "Then reply with your report for the person.",
  ];
  return lines.join("\n");
}

/**
 * The spec: what the task covers, and everything the person wrote in its thread, so a change
 * they asked for along the way isn't taken for scope creep.
 */
function specText(brief: ReviewBrief): string {
  const parts: string[] = [];
  const prompt = brief.covers.length > 0 ? taskPrompt(brief.covers) : undefined;
  let messages = brief.messages.map((text) => text.trim()).filter(Boolean);
  // The task's first message is what it covers, with anything the person added when starting it.
  if (prompt && messages[0]?.startsWith(prompt)) {
    const added = messages[0].slice(prompt.length).trim();
    messages = added ? [added, ...messages.slice(1)] : messages.slice(1);
  }
  if (brief.covers.length > 0) {
    parts.push(
      "What the task is for, in the person's words:",
      "",
      ...brief.covers.map((item, index) => `${index + 1}. ${quoted(itemText(item))}`),
    );
  }
  if (messages.length > 0) {
    if (parts.length > 0) parts.push("");
    parts.push(
      "What the person wrote while it was worked on, oldest first. Each is part of the spec, as asked for:",
      "",
      ...messages.map((text) => `- ${quoted(text)}`),
    );
  }
  if (parts.length === 0) {
    return "The person wrote nothing down for this task, so there is no spec unless an issue or a spec file below has one.";
  }
  return [
    "What the person asked for is the spec: judge the work against it, and don't count anything it asks for as scope creep.",
    "",
    ...parts,
  ].join("\n");
}

/** Text as a Markdown quote that keeps its place in a list. */
function quoted(text: string): string {
  const clipped =
    text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT)} … (cut short)` : text;
  return clipped.replaceAll("\n", "\n   ");
}

/** The review with what the reviewer reported. Once the findings went out, there is no other. */
export function reported(review: Review, findings: readonly FindingReport[], now: number): Review {
  if (review.sentAt !== undefined) {
    throw new Error(
      "The findings went to the task's agent already. A review has one round; start another review for more.",
    );
  }
  return {
    ...review,
    reportedAt: now,
    findings: findings.map((finding) => ({ ...finding, id: `f${newId().slice(0, 6)}` })),
  };
}

/** What the task's agent is sent: each finding, by id, and how to answer it. */
export function findingsMessage(review: Review): string {
  const lines = [
    "A reviewer looked over your work and found what follows. For each finding, fix it, or, if it is as intended, leave it and say why. You know why the code is as it is; the reviewer doesn't.",
    "When you've been through them all, call answer_findings with an answer for every finding: its id, `fixed` or `disputed`, and a note on what you changed or why it stays. The person decides on the ones you dispute.",
  ];
  for (const [group, findings] of grouped(review.findings)) {
    lines.push("", `## ${group}`, "");
    for (const finding of findings) {
      const place = finding.file
        ? ` (${finding.file}${finding.line !== undefined ? `:${finding.line}` : ""})`
        : "";
      lines.push(`- **${finding.id}** · ${finding.kind}${place}: ${finding.summary}`);
      if (finding.quote) lines.push(`  > ${finding.quote.replaceAll("\n", "\n  > ")}`);
    }
  }
  return lines.join("\n");
}

/** The findings by group, groups in the order they first appear. */
function grouped(findings: readonly Finding[]): [string, Finding[]][] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.group) ?? [];
    list.push(finding);
    groups.set(finding.group, list);
  }
  return [...groups];
}

/**
 * The reviews whose findings went to the task's agent, with its answers in, each in the review
 * its finding is in. A review no answer is for comes back as it was. An answer replaces one
 * given before, and a fix settles a dispute the person sent back. Throws when an id is a
 * finding of none of them.
 */
export function answered(
  reviews: readonly Review[],
  answers: readonly FindingAnswerRequest[],
): Review[] {
  const byId = new Map(answers.map((answer) => [answer.id, answer]));
  const ids = reviews.flatMap((review) => review.findings.map((finding) => finding.id));
  const unknown = [...byId.keys()].filter((id) => !ids.includes(id));
  if (unknown.length > 0) {
    throw new Error(
      `${unknown.join(", ")} ${unknown.length === 1 ? "is not a finding" : "are not findings"} of a review sent to you. Their findings are ${ids.join(", ")}.`,
    );
  }
  return reviews.map((review) => {
    if (!review.findings.some((finding) => byId.has(finding.id))) return review;
    return {
      ...review,
      findings: review.findings.map((finding) => {
        const answer = byId.get(finding.id);
        if (!answer) return finding;
        const { decision, ...rest } = finding;
        // A finding the person sent back keeps their call once it's fixed; a new dispute asks again.
        const kept = decision === "fix" && answer.outcome === "fixed" ? { decision } : {};
        return { ...rest, ...kept, answer: { outcome: answer.outcome, note: answer.note.trim() } };
      }),
    };
  });
}

/** The review with the person's call on a disputed finding. */
export function decided(review: Review, findingId: string, decision: "fix" | "agree"): Review {
  const finding = review.findings.find((entry) => entry.id === findingId);
  if (!finding) throw new Error("That finding is gone.");
  if (finding.answer?.outcome !== "disputed") {
    throw new Error("Only a finding the agent disputed waits for your call.");
  }
  return {
    ...review,
    findings: review.findings.map((entry) =>
      entry.id === findingId ? { ...entry, decision } : entry,
    ),
  };
}

/**
 * What the task's agent is sent when the person wants a disputed finding fixed anyway. It is
 * their call, so it reads as theirs.
 */
export function fixAnywayMessage(finding: Finding): string {
  return `I read why you left ${finding.id} as it is, and I want it fixed anyway: ${finding.summary}\n\nFix it, then call answer_findings for ${finding.id} again, as fixed.`;
}
