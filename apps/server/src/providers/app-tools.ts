// The tools dodocode gives agents, whatever runs them. Every agent can write down an idea it
// noticed in the board's backlog and show a web page in the thread. An agent working on a task
// can move it on the board and set how the project is reviewed, both only when the person asks,
// and answers a review's findings. A reviewer reports what it found.

import { TASK_STATUS_LABEL } from "@dodocode/protocol";
import { z } from "zod";
import { errorText } from "../util";
import type { AgentMove, SessionHost } from "./types";

/** What the agent is told about the app it works in, besides its tools' own descriptions. */
export const APP_INSTRUCTIONS = [
  "You work inside dodocode, a desktop app that shows this conversation to the person and renders your Markdown.",
  "To show the person an image file, such as a screenshot you took, embed it with Markdown image syntax and its absolute path, e.g. ![The home page](/absolute/path/to/home.png); a bare path shows only as text.",
  "To show a web page you made, such as a UI mock-up, a chart, a diagram or a prototype, call the show_page tool: it appears in the conversation, working.",
].join(" ");

export const MOVE_TASK = "move_task";

export const MOVE_TASK_DESCRIPTION = [
  "Moves the task this conversation is for to another column of the person's task board:",
  "In progress, In review or Done.",
  'Use it only when the person asks you to, as in "put it in review" or "mark it done".',
  "Never move it on your own, not even when you think the work is finished.",
].join(" ");

export const moveTaskInput = {
  status: z
    .enum(["progress", "review", "done"])
    .describe("The column: progress is In progress, review is In review, done is Done."),
};

const moveTaskArgs = z.object(moveTaskInput);

/** The tool's input as JSON Schema, for agents that take a schema rather than zod. */
export const MOVE_TASK_SCHEMA = z.toJSONSchema(moveTaskArgs);

/** What a tool call answers: the text the agent reads, and whether it worked. */
export interface ToolAnswer {
  text: string;
  ok: boolean;
}

/** Runs a move the agent asked for, with its arguments as they came. */
export function moveTask(host: SessionHost, args: unknown): ToolAnswer {
  const parsed = moveTaskArgs.safeParse(args);
  if (!parsed.success) {
    return { ok: false, text: "status must be progress, review or done." };
  }
  try {
    return { ok: true, text: host.moveTask(parsed.data.status) };
  } catch (error) {
    return { ok: false, text: errorText(error) };
  }
}

/** How a move shows in the thread, from the tool call's arguments. */
export function moveTaskTitle(args: unknown): string {
  const status = moveTaskArgs.safeParse(args).data?.status as AgentMove | undefined;
  return status ? `Move this task to ${TASK_STATUS_LABEL[status]}` : "Move this task";
}

export const ADD_IDEA = "add_idea";

export const ADD_IDEA_DESCRIPTION = [
  "Writes an idea down in the backlog of the person's task board, for them to pick up later or not.",
  "Use it when the person asks you to put something in their backlog.",
  "Use it also for something worth doing that you noticed along the way and that is not part of the work you were asked for: a bug elsewhere, a missing test, code that needs tidying.",
  "Don't use it for the work you were asked to do, or for steps of it. Add an idea you noticed without asking first, and mention it in your reply.",
].join(" ");

export const addIdeaInput = {
  title: z
    .string()
    .describe("A short name for it, as a task title, e.g. “Fix the flaky upload test”."),
  details: z
    .string()
    .optional()
    .describe("What someone picking it up later needs: where it is, what you saw, why it matters."),
};

const addIdeaArgs = z.object(addIdeaInput);

export const ADD_IDEA_SCHEMA = z.toJSONSchema(addIdeaArgs);

/** Adds the idea the agent wrote down, with its arguments as they came. */
export function addIdea(host: SessionHost, args: unknown): ToolAnswer {
  const parsed = addIdeaArgs.safeParse(args);
  if (!parsed.success || !parsed.data.title.trim()) {
    return { ok: false, text: "Give the idea a title." };
  }
  try {
    return { ok: true, text: host.addIdea(parsed.data) };
  } catch (error) {
    return { ok: false, text: errorText(error) };
  }
}

/** How an added idea shows in the thread, from the tool call's arguments. */
export function addIdeaTitle(args: unknown): string {
  const title = addIdeaArgs.safeParse(args).data?.title.trim();
  return title ? `Add “${title}” to the backlog` : "Add an idea to the backlog";
}

export const SHOW_PAGE = "show_page";

export const SHOW_PAGE_DESCRIPTION = [
  "Shows a web page in the conversation, where the person sees it working: a UI mock-up, a chart, a diagram, a prototype.",
  "Give a whole HTML document in html, or the path of an .html file in path.",
  "A page from a file loads the files beside it, such as its CSS, scripts and images; a page from html loads only what it links to on the web.",
  "Its scripts run, and it can load libraries from a CDN. It shows about 720 pixels wide, and the person can open it larger.",
  "Show a page again after you change it.",
].join(" ");

export const showPageInput = {
  title: z.string().describe("A short name for the page, shown above it."),
  html: z.string().optional().describe("A whole HTML document. Leave it out to show a file."),
  path: z
    .string()
    .optional()
    .describe("An .html file to show, absolute or relative to where you work."),
};

const showPageArgs = z.object(showPageInput);

export const SHOW_PAGE_SCHEMA = z.toJSONSchema(showPageArgs);

/** Shows the page the agent asked for, with its arguments as they came. */
export function showPage(host: SessionHost, args: unknown): ToolAnswer {
  const parsed = showPageArgs.safeParse(args);
  if (!parsed.success) {
    return { ok: false, text: "Give a title, and either html or the path of an .html file." };
  }
  try {
    return { ok: true, text: host.showPage(parsed.data) };
  } catch (error) {
    return { ok: false, text: errorText(error) };
  }
}

export const REPORT_FINDINGS = "report_findings";

export const REPORT_FINDINGS_DESCRIPTION = [
  "Reports what your review found, so the agent that did the work can answer each finding and the person can see them.",
  "Call it once, when the review is done, with every finding, or with none when you found nothing.",
  "Each finding is about one thing, so it can be fixed or answered on its own.",
].join(" ");

const finding = z.object({
  group: z
    .string()
    .describe("The axis or part of the review it came from, such as Standards or Spec."),
  kind: z
    .string()
    .describe("What sort of finding it is on its axis, such as violation or judgement call."),
  summary: z.string().describe("What is wrong, in a sentence or two."),
  file: z
    .string()
    .optional()
    .describe("The file it is in, relative to where you work. Leave it out when it is in none."),
  line: z.number().int().positive().optional().describe("The line in the file, when there is one."),
  quote: z
    .string()
    .optional()
    .describe("The code, the standard or the request it rests on, word for word."),
});

export const reportFindingsInput = {
  findings: z.array(finding).describe("Every finding. Empty when you found nothing."),
};

const reportFindingsArgs = z.object(reportFindingsInput);

export const REPORT_FINDINGS_SCHEMA = z.toJSONSchema(reportFindingsArgs);

/** Keeps what the reviewer found, with its arguments as they came. */
export function reportFindings(host: SessionHost, args: unknown): ToolAnswer {
  const parsed = reportFindingsArgs.safeParse(args);
  if (!parsed.success) {
    return {
      ok: false,
      text: "Give findings: a list where each has a group, a kind and a summary, and a file, line and quote when it has them.",
    };
  }
  const findings = parsed.data.findings
    .map((entry) => ({
      ...entry,
      group: entry.group.trim(),
      kind: entry.kind.trim(),
      summary: entry.summary.trim(),
    }))
    .filter((entry) => entry.summary);
  try {
    return { ok: true, text: host.reportFindings(findings) };
  } catch (error) {
    return { ok: false, text: errorText(error) };
  }
}

export const ANSWER_FINDINGS = "answer_findings";

export const ANSWER_FINDINGS_DESCRIPTION = [
  "Answers the findings of a review of your work, after you went through them:",
  "for each, whether you fixed it or left it as intended, and a note on what you changed or why it stays.",
  "Use it only after a review's findings were sent to you.",
].join(" ");

export const answerFindingsInput = {
  answers: z
    .array(
      z.object({
        id: z.string().describe("The finding's id, as the review gave it, such as f3a9c1."),
        outcome: z
          .enum(["fixed", "disputed"])
          .describe("fixed: you changed the code. disputed: it is as intended, and you left it."),
        note: z.string().describe("What you changed, or why it is as intended."),
      }),
    )
    .describe("An answer for each finding."),
};

const answerFindingsArgs = z.object(answerFindingsInput);

export const ANSWER_FINDINGS_SCHEMA = z.toJSONSchema(answerFindingsArgs);

/** Records the agent's answers to a review, with its arguments as they came. */
export function answerFindings(host: SessionHost, args: unknown): ToolAnswer {
  const parsed = answerFindingsArgs.safeParse(args);
  if (!parsed.success || parsed.data.answers.length === 0) {
    return {
      ok: false,
      text: "Give answers: a list where each has a finding's id, fixed or disputed, and a note.",
    };
  }
  try {
    return { ok: true, text: host.answerFindings(parsed.data.answers) };
  } catch (error) {
    return { ok: false, text: errorText(error) };
  }
}

/** How answering a review shows in the thread, from the tool call's arguments. */
export function answerFindingsTitle(args: unknown): string {
  const answers = answerFindingsArgs.safeParse(args).data?.answers ?? [];
  const fixed = answers.filter((answer) => answer.outcome === "fixed").length;
  const disputed = answers.length - fixed;
  const parts = [fixed > 0 ? `${fixed} fixed` : "", disputed > 0 ? `${disputed} disputed` : ""];
  const counts = parts.filter(Boolean).join(", ");
  return counts ? `Answer the review: ${counts}` : "Answer the review";
}

export const SET_REVIEW_INSTRUCTIONS = "set_review_instructions";

export const SET_REVIEW_INSTRUCTIONS_DESCRIPTION = [
  "Sets the Markdown file that says how this project's work is reviewed, in place of dodocode's built-in way to review.",
  "Use it only when the person asks you to, as in “review with docs/review.md from now on”.",
  "The app still gives the reviewer what to review and the spec, keeps it from changing files, and has it report its findings; the file says only how to review.",
  "Give path empty to go back to the built-in way.",
].join(" ");

export const setReviewInstructionsInput = {
  path: z
    .string()
    .describe(
      "The Markdown file, relative to the project's folder or absolute. Empty: the built-in way.",
    ),
};

const setReviewInstructionsArgs = z.object(setReviewInstructionsInput);

export const SET_REVIEW_INSTRUCTIONS_SCHEMA = z.toJSONSchema(setReviewInstructionsArgs);

/** Sets the project's way to review, with the tool call's arguments as they came. */
export function setReviewInstructions(host: SessionHost, args: unknown): ToolAnswer {
  const parsed = setReviewInstructionsArgs.safeParse(args);
  if (!parsed.success) return { ok: false, text: "Give path: a Markdown file, or empty." };
  try {
    const path = parsed.data.path.trim();
    return { ok: true, text: host.setReviewInstructions(path || null) };
  } catch (error) {
    return { ok: false, text: errorText(error) };
  }
}

/** How setting the way to review shows in the thread, from the tool call's arguments. */
export function setReviewInstructionsTitle(args: unknown): string {
  const path = setReviewInstructionsArgs.safeParse(args).data?.path.trim();
  return path ? `Review this project as ${path} says` : "Review this project the built-in way";
}

/** What a reviewer is told, besides APP_INSTRUCTIONS, and holds to after its first message. */
export const REVIEWER_INSTRUCTIONS = [
  "In this conversation you review a task's work that another agent did.",
  "You only read: don't change, create or delete files, don't commit, and don't run anything that changes the project.",
  "Report what you find with report_findings; the agent that did the work answers it.",
].join(" ");

/** One of the app's tools, as both providers give it to their agent. */
export interface AppTool {
  name: string;
  description: string;
  /** The input, for agents that take zod. */
  input: z.ZodRawShape;
  /** The input as JSON Schema, for agents that take a schema. */
  schema: object;
  run(host: SessionHost, args: unknown): ToolAnswer;
  /** How a call shows in the thread. Unset: it shows as what it made, not as a tool call. */
  title?(args: unknown): string;
}

const TOOLS: Record<string, AppTool & { for: "worker" | "reviewer" | "both" }> = {
  [MOVE_TASK]: {
    for: "worker",
    name: MOVE_TASK,
    description: MOVE_TASK_DESCRIPTION,
    input: moveTaskInput,
    schema: MOVE_TASK_SCHEMA,
    run: moveTask,
    title: moveTaskTitle,
  },
  [ANSWER_FINDINGS]: {
    for: "worker",
    name: ANSWER_FINDINGS,
    description: ANSWER_FINDINGS_DESCRIPTION,
    input: answerFindingsInput,
    schema: ANSWER_FINDINGS_SCHEMA,
    run: answerFindings,
    title: answerFindingsTitle,
  },
  [SET_REVIEW_INSTRUCTIONS]: {
    for: "worker",
    name: SET_REVIEW_INSTRUCTIONS,
    description: SET_REVIEW_INSTRUCTIONS_DESCRIPTION,
    input: setReviewInstructionsInput,
    schema: SET_REVIEW_INSTRUCTIONS_SCHEMA,
    run: setReviewInstructions,
    title: setReviewInstructionsTitle,
  },
  // The findings show as themselves, in a card of their own.
  [REPORT_FINDINGS]: {
    for: "reviewer",
    name: REPORT_FINDINGS,
    description: REPORT_FINDINGS_DESCRIPTION,
    input: reportFindingsInput,
    schema: REPORT_FINDINGS_SCHEMA,
    run: reportFindings,
  },
  [ADD_IDEA]: {
    for: "both",
    name: ADD_IDEA,
    description: ADD_IDEA_DESCRIPTION,
    input: addIdeaInput,
    schema: ADD_IDEA_SCHEMA,
    run: addIdea,
    title: addIdeaTitle,
  },
  // A page shows as itself.
  [SHOW_PAGE]: {
    for: "both",
    name: SHOW_PAGE,
    description: SHOW_PAGE_DESCRIPTION,
    input: showPageInput,
    schema: SHOW_PAGE_SCHEMA,
    run: showPage,
  },
};

/** Every tool the app has, whichever agent gets it. */
export const ALL_APP_TOOLS: readonly AppTool[] = Object.values(TOOLS);

/** The tools an agent gets: a reviewer's only read and report, a worker's move and answer. */
export function appToolsFor(reviewing: boolean): AppTool[] {
  const role = reviewing ? "reviewer" : "worker";
  return Object.values(TOOLS).filter((tool) => tool.for === role || tool.for === "both");
}

/** The app's tool named `name`, if it has one. */
export function appTool(name: string): AppTool | undefined {
  return Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
}

/** Runs the app's tool an agent called, with its arguments as they came. */
export function runAppTool(host: SessionHost, name: string, args: unknown): ToolAnswer {
  const tool = appToolsFor(host.reviewing).find((entry) => entry.name === name);
  return tool ? tool.run(host, args) : { ok: false, text: `dodocode has no tool named ${name}.` };
}

/** What an agent is told about the app, for the role it has. */
export function appInstructions(reviewing: boolean): string {
  return reviewing ? `${APP_INSTRUCTIONS} ${REVIEWER_INSTRUCTIONS}` : APP_INSTRUCTIONS;
}
