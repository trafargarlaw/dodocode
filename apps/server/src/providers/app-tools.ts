// The tools dodocode gives every agent, whatever runs it. For now there is one: moving its own
// task on the person's board, which it does only when the person asks it to.

import { TASK_STATUS_LABEL } from "@dodocode/protocol";
import { z } from "zod";
import { errorText } from "../util";
import type { AgentMove, SessionHost } from "./types";

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
