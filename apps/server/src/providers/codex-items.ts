// How Codex's items show as dodocode items, live or read from Codex's history.

import type { FileChange } from "@dodocode/protocol";

import { appTool } from "./app-tools";
import { relativePath } from "./claude-tools";
import type { ItemWriter } from "./types";

export interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? text;
}

/** The shells Codex wraps each command in, with the command as their last argument. */
const SHELL_WRAPPERS = [
  /^"?[^"]*?\b(?:powershell|pwsh)(?:\.exe)?"?\s+(?:-\w+\s+)*-Command\s+"([\s\S]*)"$/i,
  /^"?[^"]*?\b(?:bash|zsh|sh)(?:\.exe)?"?\s+-l?c\s+'([\s\S]*)'$/,
  /^"?[^"]*?\b(?:bash|zsh|sh)(?:\.exe)?"?\s+-l?c\s+"([\s\S]*)"$/,
  /^"?[^"]*?\bcmd(?:\.exe)?"?\s+\/[cC]\s+([\s\S]*)$/,
];

/** The command the agent wrote, without the shell Codex runs it in. */
export function shownCommand(command: string): string {
  const text = command.trim();
  for (const wrapper of SHELL_WRAPPERS) {
    const inner = wrapper.exec(text)?.[1];
    if (inner?.trim()) return inner.trim();
  }
  return text;
}

/** Writes one Codex thread's items, the main thread's or a subagent's, into a dodocode thread. */
export class ItemMapper {
  readonly writer: ItemWriter;
  private cwd: string;
  private reasoningIndex = new Map<string, number>();
  /** The time now: the clock's, live, or the item's, for a thread read from Codex's history. */
  private now: () => number;

  constructor(writer: ItemWriter, cwd: string, now: () => number = Date.now) {
    this.writer = writer;
    this.cwd = cwd;
    this.now = now;
  }

  changes(item: CodexItem): FileChange[] {
    const changes = (item.changes ?? []) as {
      path: string;
      kind: { type: "add" | "delete" | "update"; move_path?: string | null };
      diff: string;
    }[];
    return changes.map((change) => ({
      path: relativePath(change.path, this.cwd),
      kind: change.kind.type === "update" && change.kind.move_path ? "move" : change.kind.type,
      diff: change.diff,
      movedTo: change.kind.move_path ? relativePath(change.kind.move_path, this.cwd) : undefined,
    }));
  }

  started(item: CodexItem): void {
    if (this.writer.get(item.id)) return;
    switch (item.type) {
      case "agentMessage":
        this.writer.add({
          id: item.id,
          type: "assistant",
          text: String(item.text ?? ""),
          streaming: true,
        });
        return;
      case "reasoning":
        this.writer.add({ id: item.id, type: "reasoning", text: "", streaming: true });
        return;
      case "contextCompaction":
        this.writer.add({
          id: item.id,
          type: "notice",
          level: "info",
          text: "Compacted the conversation.",
        });
        return;
      case "userMessage":
      case "hookPrompt":
        return;
      default: {
        const tool = this.tool(item);
        if (!tool) return;
        const { output, ...fields } = tool;
        this.writer.add({
          id: item.id,
          type: "tool",
          ...fields,
          output: output ?? "",
          status: "running",
        });
      }
    }
  }

  completed(item: CodexItem): void {
    if (!this.writer.get(item.id)) this.started(item);
    if (!this.writer.get(item.id)) return;
    switch (item.type) {
      case "agentMessage":
        this.writer.update(item.id, { text: String(item.text ?? ""), streaming: false });
        return;
      case "reasoning": {
        const summary = ((item.summary ?? []) as string[]).join("\n\n");
        this.writer.update(
          item.id,
          summary ? { text: summary, streaming: false } : { streaming: false },
        );
        return;
      }
      case "contextCompaction":
        return;
      default: {
        const tool = this.tool(item);
        if (!tool) return;
        const status = String(item.status ?? "completed");
        const { output, ...fields } = tool;
        this.writer.update(item.id, {
          ...fields,
          ...(output !== undefined ? { output } : {}),
          status: status === "failed" ? "error" : status === "declined" ? "denied" : "done",
          endedAt: this.now(),
        });
      }
    }
  }

  appendText(itemId: string, delta: string): void {
    this.writer.append(itemId, "text", delta);
  }

  appendReasoning(itemId: string, delta: string, summaryIndex: number): void {
    if (!this.writer.get(itemId)) {
      this.writer.add({ id: itemId, type: "reasoning", text: "", streaming: true });
    }
    const last = this.reasoningIndex.get(itemId);
    if (last !== undefined && last !== summaryIndex) this.writer.append(itemId, "text", "\n\n");
    this.reasoningIndex.set(itemId, summaryIndex);
    this.writer.append(itemId, "text", delta);
  }

  appendOutput(itemId: string, delta: string): void {
    this.writer.append(itemId, "output", delta);
  }

  /** How a Codex tool item shows, or undefined for items that are not tools. */
  private tool(item: CodexItem) {
    switch (item.type) {
      case "commandExecution": {
        const command = String(item.command ?? "");
        return {
          kind: "command" as const,
          name: "shell",
          title: firstLine(shownCommand(command)),
          input: { command: shownCommand(command), fullCommand: command, cwd: item.cwd },
          exitCode: typeof item.exitCode === "number" ? item.exitCode : undefined,
          output: typeof item.aggregatedOutput === "string" ? item.aggregatedOutput : undefined,
        };
      }
      case "fileChange": {
        const changes = this.changes(item);
        return {
          kind: "edit" as const,
          name: "apply_patch",
          title: changes.map((change) => change.path).join(", ") || "Edit files",
          input: { changes: item.changes },
          changes,
        };
      }
      case "mcpToolCall": {
        const result = item.result as { content?: { type: string; text?: string }[] } | null;
        const error = item.error as { message?: string } | null;
        const output =
          error?.message ??
          result?.content
            ?.map((part) => part.text ?? "")
            .filter(Boolean)
            .join("\n");
        return {
          kind: "mcp" as const,
          name: `${item.server}/${item.tool}`,
          title: `${item.server}: ${item.tool}`,
          input: item.arguments,
          output,
        };
      }
      case "dynamicToolCall": {
        const own = appTool(String(item.tool ?? ""));
        // A page, or findings, show as themselves.
        if (own && !own.title) return undefined;
        return {
          kind: "other" as const,
          name: String(item.tool ?? "tool"),
          title: own?.title ? own.title(item.arguments) : String(item.tool ?? "Tool"),
          input: item.arguments,
        };
      }
      case "webSearch":
        return {
          kind: "web" as const,
          name: "web_search",
          title: String(item.query ?? "Search the web"),
          input: { query: item.query },
        };
      case "plan":
        return {
          kind: "plan" as const,
          name: "plan",
          title: "Plan",
          input: {},
          output: String(item.text ?? ""),
        };
      case "collabAgentToolCall":
        return {
          kind: "subagent" as const,
          name: String(item.tool ?? "agent"),
          title: firstLine(String(item.prompt ?? "")) || String(item.tool ?? "Subagent"),
          input: { prompt: item.prompt, model: item.model },
        };
      case "imageGeneration":
        return {
          kind: "other" as const,
          name: "image_generation",
          title: "Generate an image",
          input: {},
        };
      case "imageView":
        return {
          kind: "read" as const,
          name: "view_image",
          title: String(item.path ?? "View an image"),
          input: { path: item.path },
        };
      default:
        return undefined;
    }
  }
}
