// Turns the messages of one Claude conversation, the main one or a subagent's, into items.

import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import type { ItemWriter } from "./types";
import { changesForInput, changesFromResult, describeTool, todosFrom } from "./claude-tools";

export interface TranscriptHooks {
  subagentStarted(toolId: string, title: string, parent: Transcript): void;
  subagentReturned(toolId: string, isError: boolean, background: boolean): void;
  toolDenied(toolId: string): boolean;
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  thinking?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

type StreamKind = "text" | "thinking";

/** Tools whose calls show as something else, or not at all. */
const HIDDEN_TOOLS = new Set(["AskUserQuestion"]);

export class Transcript {
  readonly writer: ItemWriter;
  private cwd: string;
  private hooks: TranscriptHooks;
  private tools = new Map<string, { name: string; input: Record<string, unknown> }>();
  private hidden = new Set<string>();
  private streamMessage: string | undefined;
  private streamBlocks = new Map<number, string>();
  /** Items streamed for each message, in order, so the full message can fill them in. */
  private streamed = new Map<string, Record<StreamKind, string[]>>();
  private filled = new Map<string, Record<StreamKind, number>>();
  private awaitingPrompt: boolean;

  constructor(writer: ItemWriter, cwd: string, hooks: TranscriptHooks, subagent = false) {
    this.writer = writer;
    this.cwd = cwd;
    this.hooks = hooks;
    this.awaitingPrompt = subagent;
  }

  hasTool(id: string): boolean {
    return this.tools.has(id);
  }

  /** Subagents that run in the foreground now. */
  runningSubagents(): string[] {
    return [...this.tools.entries()]
      .filter(([id, tool]) => {
        if (tool.name !== "Agent" && tool.name !== "Task") return false;
        const item = this.writer.get(id);
        return item?.type === "tool" && item.status === "running" && !item.background;
      })
      .map(([id]) => id);
  }

  endTurn(): void {
    this.streamMessage = undefined;
    this.streamBlocks.clear();
    this.streamed.clear();
    this.filled.clear();
  }

  textOf(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return (content as Block[])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n");
  }

  /** Returns true when the message carried text from the agent. */
  handle(message: SDKMessage): boolean {
    if (message.type === "stream_event") {
      this.handleStream(message.event as unknown as Record<string, unknown>);
      return false;
    }
    if (message.type === "assistant") {
      return this.handleAssistant(message.message as unknown as { id: string; content: Block[] });
    }
    if (message.type === "user") {
      this.handleUser(message.message.content, message.tool_use_result);
    }
    return false;
  }

  // Streaming

  private handleStream(event: Record<string, unknown>): void {
    switch (event.type) {
      case "message_start": {
        const message = event.message as { id?: string } | undefined;
        this.streamMessage = message?.id;
        this.streamBlocks.clear();
        return;
      }
      case "content_block_start": {
        const block = event.content_block as Block;
        const index = event.index as number;
        if (block.type !== "text" && block.type !== "thinking") return;
        const kind: StreamKind = block.type;
        const item = this.writer.add(
          kind === "text"
            ? { type: "assistant", text: block.text ?? "", streaming: true }
            : { type: "reasoning", text: block.thinking ?? "", streaming: true },
        );
        this.streamBlocks.set(index, item.id);
        if (this.streamMessage) {
          const streamed = this.streamed.get(this.streamMessage) ?? { text: [], thinking: [] };
          streamed[kind].push(item.id);
          this.streamed.set(this.streamMessage, streamed);
        }
        return;
      }
      case "content_block_delta": {
        const itemId = this.streamBlocks.get(event.index as number);
        if (!itemId) return;
        const delta = event.delta as { type: string; text?: string; thinking?: string };
        if (delta.type === "text_delta" && delta.text)
          this.writer.append(itemId, "text", delta.text);
        if (delta.type === "thinking_delta" && delta.thinking) {
          this.writer.append(itemId, "text", delta.thinking);
        }
        return;
      }
      case "content_block_stop": {
        const itemId = this.streamBlocks.get(event.index as number);
        if (itemId) this.writer.update(itemId, { streaming: false });
        return;
      }
      default:
        return;
    }
  }

  /** The streamed item that the next full block of this kind fills in, if any. */
  private claimStreamed(messageId: string, kind: StreamKind): string | undefined {
    const streamed = this.streamed.get(messageId);
    if (!streamed) return undefined;
    const filled = this.filled.get(messageId) ?? { text: 0, thinking: 0 };
    const id = streamed[kind][filled[kind]];
    if (id) {
      filled[kind] += 1;
      this.filled.set(messageId, filled);
    }
    return id;
  }

  // Full messages

  private handleAssistant(message: { id: string; content: Block[] }): boolean {
    let sawText = false;
    for (const block of message.content) {
      switch (block.type) {
        case "text": {
          const text = block.text ?? "";
          const streamed = this.claimStreamed(message.id, "text");
          if (streamed) this.writer.update(streamed, { text, streaming: false });
          else if (text.trim()) this.writer.add({ type: "assistant", text, streaming: false });
          if (text.trim()) sawText = true;
          break;
        }
        case "thinking": {
          const text = block.thinking ?? "";
          const streamed = this.claimStreamed(message.id, "thinking");
          if (streamed) this.writer.update(streamed, { text, streaming: false });
          else if (text.trim()) this.writer.add({ type: "reasoning", text, streaming: false });
          break;
        }
        case "tool_use":
        case "server_tool_use":
          this.toolStarted(block);
          break;
        case "web_search_tool_result":
          if (block.tool_use_id) {
            this.writer.update(block.tool_use_id, { status: "done", endedAt: Date.now() });
          }
          break;
        default:
          break;
      }
    }
    return sawText;
  }

  private toolStarted(block: Block): void {
    const id = block.id;
    const name = block.name ?? "tool";
    if (!id || this.tools.has(id)) return;
    const input = (block.input ?? {}) as Record<string, unknown>;
    this.tools.set(id, { name, input });
    if (HIDDEN_TOOLS.has(name)) {
      this.hidden.add(id);
      return;
    }
    const { kind, title } = describeTool(name, input, this.cwd);
    this.writer.add({
      id,
      type: "tool",
      kind,
      name,
      title,
      input,
      output: "",
      status: "running",
      changes: kind === "edit" ? changesForInput(name, input, this.cwd) : undefined,
      todos: name === "TodoWrite" ? todosFrom(input) : undefined,
    });
    if (kind === "subagent") this.hooks.subagentStarted(id, title, this);
  }

  private handleUser(content: unknown, structured: unknown): void {
    if (typeof content === "string") {
      this.userText(content);
      return;
    }
    if (!Array.isArray(content)) return;
    for (const block of content as Block[]) {
      if (block.type === "tool_result" && block.tool_use_id) {
        this.toolFinished(block, structured);
      } else if (block.type === "text" && block.text) {
        this.userText(block.text);
      }
    }
  }

  /** A subagent's prompt arrives as its first user message. The main conversation's are shown already. */
  private userText(text: string): void {
    if (!this.awaitingPrompt || !text.trim()) return;
    this.awaitingPrompt = false;
    this.writer.add({ type: "user", text, images: [] });
  }

  private toolFinished(block: Block, structured: unknown): void {
    const id = block.tool_use_id!;
    const tool = this.tools.get(id);
    if (this.hidden.has(id)) return;
    const item = this.writer.get(id);
    if (!tool || item?.type !== "tool") return;
    const output = this.textOf(block.content);
    const isError = Boolean(block.is_error);
    const result = (structured ?? {}) as Record<string, unknown>;
    const launchedInBackground =
      result.status === "async_launched" ||
      result.isAsync === true ||
      typeof result.backgroundTaskId === "string";
    const background = item.background || launchedInBackground;
    const status = this.hooks.toolDenied(id)
      ? "denied"
      : isError
        ? "error"
        : background
          ? "running"
          : "done";
    this.writer.update(id, {
      output,
      status,
      background: background || undefined,
      endedAt: background ? undefined : Date.now(),
      exitCode: typeof result.exitCode === "number" ? result.exitCode : undefined,
      changes:
        item.kind === "edit" && !isError
          ? changesFromResult(tool.name, tool.input, structured, this.cwd)
          : item.changes,
    });
    if (item.kind === "subagent") this.hooks.subagentReturned(id, isError, Boolean(background));
  }
}
