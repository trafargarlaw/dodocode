// The tools dodocode gives every agent, whatever runs it: moving its own task on the person's
// board, which it does only when the person asks it to, writing down an idea it noticed in the
// board's backlog, and showing a web page in the thread.

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
