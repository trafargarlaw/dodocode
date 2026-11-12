// What Claude Code's tools look like in a thread: a kind, a one-line title, and file changes.

import { isAbsolute, relative } from "node:path";

import type { FileChange, TodoEntry, ToolKind } from "@dodocode/protocol";

import { ADD_IDEA, addIdeaTitle, MOVE_TASK, moveTaskTitle, SHOW_PAGE } from "./app-tools";

/** The in-process server that gives Claude dodocode's own tools, as `mcp__dodocode__<tool>`. */
export const APP_SERVER = "dodocode";

const MOVE_TASK_TOOL = `mcp__${APP_SERVER}__${MOVE_TASK}`;

const ADD_IDEA_TOOL = `mcp__${APP_SERVER}__${ADD_IDEA}`;

/** Shows as the page it shows, not as a tool call. */
export const SHOW_PAGE_TOOL = `mcp__${APP_SERVER}__${SHOW_PAGE}`;

/** The app's tools are always allowed: none of them changes files or runs anything. */
export const APP_TOOLS = [MOVE_TASK_TOOL, ADD_IDEA_TOOL, SHOW_PAGE_TOOL];

export function relativePath(path: string, cwd: string): string {
  if (!path || !isAbsolute(path)) return path;
  const inside = relative(cwd, path);
  return inside && !inside.startsWith("..") && !isAbsolute(inside)
    ? inside.replaceAll("\\", "/")
    : path;
}

function firstLine(value: string, max = 160): string {
  const line = value.split("\n").find((part) => part.trim()) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export function describeTool(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): { kind: ToolKind; title: string } {
  const path = relativePath(
    text(input.file_path) || text(input.notebook_path) || text(input.path),
    cwd,
  );
  switch (name) {
    case "Bash":
      return { kind: "command", title: firstLine(text(input.command)) || "Run a command" };
    case "BashOutput":
    case "TaskOutput":
      return { kind: "command", title: "Read background output" };
    case "KillShell":
    case "KillBash":
    case "TaskStop":
      return { kind: "command", title: "Stop a background command" };
    case "Monitor":
      return { kind: "command", title: text(input.description) || "Watch a command" };
    case "Read":
      return { kind: "read", title: path || "Read a file" };
    case "Write":
      return { kind: "edit", title: path || "Write a file" };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { kind: "edit", title: path || "Edit a file" };
    case "Glob":
      return { kind: "search", title: text(input.pattern) || "Find files" };
    case "Grep":
      return {
        kind: "search",
        title: [text(input.pattern), path].filter(Boolean).join(" in ") || "Search",
      };
    case "LS":
      return { kind: "read", title: path || "List a folder" };
    case "WebFetch":
      return { kind: "web", title: text(input.url) || "Fetch a page" };
    case "WebSearch":
    case "web_search":
      return { kind: "web", title: text(input.query) || "Search the web" };
    case "Agent":
    case "Task":
      return { kind: "subagent", title: text(input.description) || "Run a subagent" };
    case "TodoWrite":
      return { kind: "todo", title: "Update the plan" };
    case "ExitPlanMode":
      return { kind: "plan", title: "Propose a plan" };
    case "Skill":
      return {
        kind: "other",
        title: `Use the ${text(input.skill) || text(input.command) || ""} skill`.replace("  ", " "),
      };
    case MOVE_TASK_TOOL:
      return { kind: "other", title: moveTaskTitle(input) };
    case ADD_IDEA_TOOL:
      return { kind: "other", title: addIdeaTitle(input) };
    default: {
      if (name.startsWith("mcp__")) {
        const [, server, ...tool] = name.split("__");
        return { kind: "mcp", title: `${server}: ${tool.join("__")}` };
      }
      return { kind: "other", title: name };
    }
  }
}

export function todosFrom(input: Record<string, unknown>): TodoEntry[] | undefined {
  const todos = input.todos;
  if (!Array.isArray(todos)) return undefined;
  return todos.map((todo: { content?: string; status?: string }) => ({
    text: todo.content ?? "",
    status:
      todo.status === "completed"
        ? "completed"
        : todo.status === "in_progress"
          ? "in_progress"
          : "pending",
  }));
}

function lines(value: string): string[] {
  if (!value) return [];
  const parts = value.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
}

/** A diff that replaces all of `before` with `after`, for when no patch is known. */
export function wholeDiff(path: string, before: string, after: string): string {
  const removed = lines(before);
  const added = lines(after);
  const header = `--- a/${path}\n+++ b/${path}\n@@ -${removed.length ? 1 : 0},${removed.length} +${added.length ? 1 : 0},${added.length} @@\n`;
  return (
    header + [...removed.map((line) => `-${line}`), ...added.map((line) => `+${line}`)].join("\n")
  );
}

interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

function patchDiff(path: string, hunks: Hunk[]): string {
  const body = hunks
    .map(
      (hunk) =>
        `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n${hunk.lines.join("\n")}`,
    )
    .join("\n");
  return `--- a/${path}\n+++ b/${path}\n${body}`;
}

/** The changes a tool call asks to make, from its input alone. */
export function changesForInput(
  name: string,
  input: Record<string, unknown>,
  cwd: string,
): FileChange[] | undefined {
  const path = relativePath(text(input.file_path) || text(input.notebook_path), cwd);
  if (!path) return undefined;
  switch (name) {
    case "Write":
      return [{ path, kind: "add", diff: wholeDiff(path, "", text(input.content)) }];
    case "Edit":
      return [
        {
          path,
          kind: "update",
          diff: wholeDiff(path, text(input.old_string), text(input.new_string)),
        },
      ];
    case "MultiEdit": {
      const edits = Array.isArray(input.edits)
        ? (input.edits as { old_string?: string; new_string?: string }[])
        : [];
      const diff = edits
        .map((edit) => wholeDiff(path, edit.old_string ?? "", edit.new_string ?? ""))
        .join("\n");
      return [{ path, kind: "update", diff }];
    }
    case "NotebookEdit":
      return [{ path, kind: "update", diff: wholeDiff(path, "", text(input.new_source)) }];
    default:
      return undefined;
  }
}

/** The changes a finished tool call made, from the structured result Claude Code returns. */
export function changesFromResult(
  name: string,
  input: Record<string, unknown>,
  result: unknown,
  cwd: string,
): FileChange[] | undefined {
  const fallback = changesForInput(name, input, cwd);
  if (!result || typeof result !== "object") return fallback;
  const value = result as {
    type?: string;
    filePath?: string;
    structuredPatch?: Hunk[];
    content?: string;
  };
  const path = relativePath(value.filePath ?? text(input.file_path), cwd);
  if (!path) return fallback;
  const kind = value.type === "create" ? "add" : "update";
  if (Array.isArray(value.structuredPatch) && value.structuredPatch.length > 0) {
    return [{ path, kind, diff: patchDiff(path, value.structuredPatch) }];
  }
  if (value.type === "create" && typeof value.content === "string") {
    return [{ path, kind, diff: wholeDiff(path, "", value.content) }];
  }
  return fallback?.map((change) => ({ ...change, kind }));
}
