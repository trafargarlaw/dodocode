// Codex, through `codex app-server`. One process serves every thread; its notifications and
// requests carry a Codex thread id, which routes them to the dodocode thread they belong to.

import type {
  FileChange,
  ModelOption,
  Question,
  SlashCommand,
  ThreadSettings,
} from "@dodocode/protocol";

import { errorText, log, wellFormed } from "../util";
import {
  ADD_IDEA,
  ADD_IDEA_DESCRIPTION,
  ADD_IDEA_SCHEMA,
  addIdea,
  addIdeaTitle,
  APP_INSTRUCTIONS,
  MOVE_TASK,
  MOVE_TASK_DESCRIPTION,
  MOVE_TASK_SCHEMA,
  moveTask,
  moveTaskTitle,
  SHOW_PAGE,
  SHOW_PAGE_DESCRIPTION,
  SHOW_PAGE_SCHEMA,
  showPage,
  type ToolAnswer,
} from "./app-tools";
import { relativePath } from "./claude-tools";
import { CodexProcess, RpcError } from "./codex-rpc";
import { findOnPath } from "./env";
import type {
  ItemWriter,
  Provider,
  ProviderCheck,
  ProviderSession,
  SessionHost,
  SubagentWriter,
  TurnMessage,
} from "./types";

interface Route {
  notification(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  exited(reason: string): void;
}

/**
 * Codex's own slash commands belong to its terminal app. The app server can compact a thread,
 * and dodocode runs that for `/compact`.
 */
const CODEX_COMMANDS: SlashCommand[] = [
  { name: "compact", description: "Free up context by summarizing the conversation so far" },
];

/** Whether a message is `/compact`, which Codex runs as a compaction rather than a prompt. */
export function isCompact(text: string): boolean {
  return /^\/compact\s*$/i.test(text.trim());
}

interface CodexModel {
  model: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  supportedReasoningEfforts: { reasoningEffort: string }[];
  defaultReasoningEffort: string;
}

export class CodexProvider implements Provider {
  readonly id = "codex" as const;
  readonly label = "Codex";
  private process: CodexProcess | undefined;
  private routes = new Map<string, Route>();

  private executable(): string | undefined {
    return process.env.DODOCODE_CODEX_PATH || findOnPath("codex");
  }

  /** The running app-server, started when first needed. */
  async server(): Promise<CodexProcess> {
    if (this.process?.running) {
      await this.process.ready;
      return this.process;
    }
    const executable = this.executable();
    if (!executable) throw new Error("Codex is not installed.");
    const process = new CodexProcess(executable, {
      notification: (method, params) => this.route(params)?.notification(method, params),
      request: async (method, params) => {
        const route = this.route(params);
        if (!route) throw new RpcError(-32601, `dodocode does not handle ${method} here.`);
        return route.request(method, params);
      },
      exited: (reason) => {
        if (this.process === process) this.process = undefined;
        for (const route of new Set(this.routes.values())) route.exited(reason);
        this.routes.clear();
      },
    });
    this.process = process;
    await process.ready;
    return process;
  }

  private route(params: Record<string, unknown>): Route | undefined {
    const threadId = (params.threadId ?? params.conversationId) as string | undefined;
    return threadId ? this.routes.get(threadId) : undefined;
  }

  addRoute(codexThreadId: string, route: Route): void {
    this.routes.set(codexThreadId, route);
  }

  removeRoute(codexThreadId: string): void {
    this.routes.delete(codexThreadId);
  }

  async check(): Promise<ProviderCheck> {
    const base = { id: this.id, label: this.label, models: [] as ModelOption[] };
    if (!this.executable()) {
      return { ...base, status: "missing", message: "Codex is not installed." };
    }
    try {
      const server = await this.server();
      const { userAgent } = await server.ready;
      const account = (await server.request("account/read", {})) as {
        account?: unknown;
        requiresOpenaiAuth?: boolean;
      };
      const models: ModelOption[] = [];
      let cursor: string | null = null;
      do {
        const page = (await server.request("model/list", { cursor, includeHidden: false })) as {
          data: CodexModel[];
          nextCursor: string | null;
        };
        for (const model of page.data) {
          if (model.hidden) continue;
          const option: ModelOption = {
            id: model.model,
            label: model.displayName,
            description: model.description,
            efforts: model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort),
            defaultEffort: model.defaultReasoningEffort,
          };
          if (model.isDefault) models.unshift(option);
          else models.push(option);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const version = userAgent?.match(/\/(\S+)/)?.[1];
      if (account.requiresOpenaiAuth && !account.account) {
        return {
          ...base,
          models,
          version,
          status: "error",
          message: "Codex is not signed in. Run `codex login` in a terminal.",
        };
      }
      return { ...base, status: "ready", version, models, commands: CODEX_COMMANDS };
    } catch (error) {
      return { ...base, status: "error", message: errorText(error) };
    }
  }

  createSession(host: SessionHost): ProviderSession {
    return new CodexSession(this, host);
  }
}

/**
 * Supervised: Codex asks before every edit and every command it does not know to be read-only.
 * What the person allows runs in a sandbox that can write the project and reach the network; a
 * read-only sandbox would refuse the very writes they allowed.
 */
function accessPolicy(settings: ThreadSettings, cwd: string) {
  return settings.access === "full"
    ? { approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } }
    : {
        approvalPolicy: "untrusted",
        sandboxPolicy: { type: "workspaceWrite", writableRoots: [cwd], networkAccess: true },
      };
}

function userInput(message: TurnMessage): unknown[] {
  return [
    { type: "text", text: wellFormed(message.text), text_elements: [] },
    ...message.images.map((image) => ({ type: "localImage", path: image.path })),
  ];
}

interface CodexItem {
  type: string;
  id: string;
  [key: string]: unknown;
}

function firstLine(text: string): string {
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
class ItemMapper {
  readonly writer: ItemWriter;
  private cwd: string;
  private reasoningIndex = new Map<string, number>();

  constructor(writer: ItemWriter, cwd: string) {
    this.writer = writer;
    this.cwd = cwd;
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
          endedAt: Date.now(),
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
      case "dynamicToolCall":
        // A page shows as itself.
        if (item.tool === SHOW_PAGE) return undefined;
        return {
          kind: "other" as const,
          name: String(item.tool ?? "tool"),
          title:
            item.tool === MOVE_TASK
              ? moveTaskTitle(item.arguments)
              : item.tool === ADD_IDEA
                ? addIdeaTitle(item.arguments)
                : String(item.tool ?? "Tool"),
          input: item.arguments,
        };
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

interface CodexTurn {
  id: string | undefined;
  interrupted: boolean;
  startTotal: { input: number; output: number };
}

class CodexSession implements ProviderSession, Route {
  private provider: CodexProvider;
  private host: SessionHost;
  private items: ItemMapper;
  private threadId: string | undefined;
  private turn: CodexTurn | undefined;
  private totals = { input: 0, output: 0 };
  private planItems = new Map<string, string>();
  /** Subagent threads by their Codex thread id. */
  private children = new Map<string, { mapper: ItemMapper; writer: SubagentWriter }>();
  private prompts = new Map<string, AbortController>();
  private allowedCommands = new Set<string>();
  private allowEdits = false;
  private disposed = false;

  constructor(provider: CodexProvider, host: SessionHost) {
    this.provider = provider;
    this.host = host;
    this.items = new ItemMapper(host.items, host.cwd);
  }

  // ProviderSession

  async startTurn(message: TurnMessage): Promise<void> {
    this.turn = { id: undefined, interrupted: false, startTotal: { ...this.totals } };
    const turn = this.turn;
    const server = await this.provider.server();
    const threadId = await this.ensureThread();
    if (isCompact(message.text) && message.images.length === 0) {
      // The compaction runs as a turn of its own, whose events end this one.
      await server.request("thread/compact/start", { threadId });
      return;
    }
    const settings = this.host.settings();
    const response = (await server.request("turn/start", {
      threadId,
      input: userInput(message),
      cwd: this.host.cwd,
      model: settings.model || null,
      effort: settings.effort || null,
      summary: "detailed",
      approvalsReviewer: "user",
      ...accessPolicy(settings, this.host.cwd),
    })) as { turn?: { id: string } };
    if (turn === this.turn && !turn.id) turn.id = response.turn?.id;
  }

  async steer(message: TurnMessage): Promise<boolean> {
    const turn = this.turn;
    if (!turn?.id || !this.threadId) return false;
    try {
      const server = await this.provider.server();
      await server.request("turn/steer", {
        threadId: this.threadId,
        expectedTurnId: turn.id,
        input: userInput(message),
      });
      return true;
    } catch (error) {
      log("codex", "steer failed", errorText(error));
      return false;
    }
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn) return;
    turn.interrupted = true;
    for (const controller of this.prompts.values()) controller.abort();
    // The turn id can arrive after the request to start it.
    for (let wait = 0; !turn.id && wait < 50 && this.turn === turn; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!turn.id || !this.threadId) return;
    const server = await this.provider.server();
    await server.request("turn/interrupt", { threadId: this.threadId, turnId: turn.id });
  }

  async stopJob(jobId: string): Promise<void> {
    if (!this.threadId) return;
    const server = await this.provider.server();
    await server.request("thread/backgroundTerminals/terminate", {
      threadId: this.threadId,
      processId: jobId,
    });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (!this.threadId) return;
    this.provider.removeRoute(this.threadId);
    for (const id of this.children.keys()) this.provider.removeRoute(id);
    try {
      const server = await this.provider.server();
      await server.request("thread/unsubscribe", { threadId: this.threadId });
    } catch (error) {
      log("codex", "unsubscribe failed", errorText(error));
    }
    this.threadId = undefined;
  }

  private async ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;
    const server = await this.provider.server();
    const settings = this.host.settings();
    const common = {
      cwd: this.host.cwd,
      model: settings.model || null,
      config: { "tools.update_plan.enabled": true },
      developerInstructions: APP_INSTRUCTIONS,
    };
    const resumeId = this.host.resumeId;
    let threadId: string | undefined;
    if (resumeId) {
      const resume = () =>
        server.request("thread/resume", { threadId: resumeId, excludeTurns: true, ...common });
      try {
        try {
          await resume();
        } catch (error) {
          if (!/archived|codex unarchive/i.test(errorText(error))) throw error;
          await server.request("thread/unarchive", { threadId: resumeId });
          await resume();
        }
        threadId = resumeId;
      } catch (error) {
        const message = errorText(error);
        if (/active writer/i.test(message)) {
          throw new Error("Another Codex app has this thread open. Close it there and try again.", {
            cause: error,
          });
        }
        this.host.notice(
          "warning",
          `Codex could not reopen this thread (${message}). It starts a new one.`,
        );
      }
    }
    if (!threadId) {
      // A thread keeps the tools it starts with; resuming it takes no new ones.
      const result = (await server.request("thread/start", {
        ...common,
        dynamicTools: [
          {
            type: "function",
            name: MOVE_TASK,
            description: MOVE_TASK_DESCRIPTION,
            inputSchema: MOVE_TASK_SCHEMA,
          },
          {
            type: "function",
            name: ADD_IDEA,
            description: ADD_IDEA_DESCRIPTION,
            inputSchema: ADD_IDEA_SCHEMA,
          },
          {
            type: "function",
            name: SHOW_PAGE,
            description: SHOW_PAGE_DESCRIPTION,
            inputSchema: SHOW_PAGE_SCHEMA,
          },
        ],
      })) as { thread: { id: string } };
      threadId = result.thread.id;
      this.host.saveResumeId(threadId);
    }
    this.threadId = threadId;
    this.provider.addRoute(threadId, this);
    return threadId;
  }

  // Route

  exited(reason: string): void {
    this.threadId = undefined;
    if (this.disposed) return;
    for (const child of this.children.values()) child.writer.finish("failed", reason);
    this.children.clear();
    if (this.turn)
      this.endTurn({ status: this.turn.interrupted ? "interrupted" : "failed", error: reason });
  }

  notification(method: string, params: Record<string, unknown>): void {
    const threadId = params.threadId as string;
    const child = threadId !== this.threadId ? this.children.get(threadId) : undefined;
    const mapper = child?.mapper ?? this.items;
    switch (method) {
      case "turn/started": {
        const turn = params.turn as { id: string };
        if (child) return;
        if (!this.turn) {
          this.turn = { id: turn.id, interrupted: false, startTotal: { ...this.totals } };
          this.host.agentTurnStarted();
        } else if (!this.turn.id) {
          this.turn.id = turn.id;
        }
        return;
      }
      case "turn/completed": {
        const turn = params.turn as {
          id: string;
          status: string;
          error?: { message?: string } | null;
        };
        if (child) {
          child.writer.finish(
            turn.status === "completed"
              ? "completed"
              : turn.status === "interrupted"
                ? "stopped"
                : "failed",
            turn.error?.message,
          );
          return;
        }
        if (!this.turn || (this.turn.id && this.turn.id !== turn.id)) return;
        const status = this.turn.interrupted
          ? "interrupted"
          : turn.status === "completed"
            ? "completed"
            : turn.status === "interrupted"
              ? "interrupted"
              : "failed";
        this.endTurn({
          status,
          error:
            status === "failed"
              ? (turn.error?.message ?? "Codex stopped with an error.")
              : undefined,
          inputTokens: this.totals.input - this.turn.startTotal.input || undefined,
          outputTokens: this.totals.output - this.turn.startTotal.output || undefined,
        });
        return;
      }
      case "item/started": {
        const item = params.item as CodexItem;
        if (!child && item.type === "contextCompaction")
          this.host.contextUsed({ compacting: true });
        this.itemStarted(mapper, item);
        return;
      }
      case "item/completed": {
        const item = params.item as CodexItem;
        if (!child && item.type === "contextCompaction") {
          this.host.contextUsed({ compacting: false });
        }
        mapper.completed(item);
        return;
      }
      case "item/agentMessage/delta":
        mapper.appendText(params.itemId as string, params.delta as string);
        return;
      case "item/reasoning/summaryTextDelta":
        mapper.appendReasoning(
          params.itemId as string,
          params.delta as string,
          (params.summaryIndex as number) ?? 0,
        );
        return;
      case "item/commandExecution/outputDelta":
        mapper.appendOutput(params.itemId as string, params.delta as string);
        return;
      case "turn/plan/updated":
        this.planUpdated(mapper, params);
        return;
      case "thread/tokenUsage/updated": {
        if (child) return;
        const usage = params.tokenUsage as {
          total?: { inputTokens?: number; outputTokens?: number };
          last?: { totalTokens?: number; reasoningOutputTokens?: number };
          modelContextWindow?: number | null;
        };
        this.totals = {
          input: usage.total?.inputTokens ?? 0,
          output: usage.total?.outputTokens ?? 0,
        };
        // The last request holds the whole conversation. Its reasoning is not carried on.
        const used = (usage.last?.totalTokens ?? 0) - (usage.last?.reasoningOutputTokens ?? 0);
        if (used > 0) {
          this.host.contextUsed({
            used,
            ...(usage.modelContextWindow ? { window: usage.modelContextWindow } : {}),
          });
        }
        return;
      }
      case "thread/compacted":
        if (!child) this.host.contextUsed({ compacting: false });
        return;
      case "error": {
        const error = params.error as { message?: string } | undefined;
        if (params.willRetry) {
          this.host.notice(
            "warning",
            `Codex is retrying: ${error?.message ?? "the request failed"}.`,
          );
        }
        return;
      }
      case "model/rerouted":
        this.host.notice("info", `Codex switched to ${String(params.toModel)} for this turn.`);
        return;
      case "serverRequest/resolved": {
        const key = String(params.requestId);
        this.prompts.get(key)?.abort();
        this.prompts.delete(key);
        return;
      }
      case "thread/closed":
        if (!child && threadId === this.threadId) {
          this.provider.removeRoute(threadId);
          this.threadId = undefined;
        }
        return;
      default:
        return;
    }
  }

  private itemStarted(mapper: ItemMapper, item: CodexItem): void {
    mapper.started(item);
    if (item.type !== "collabAgentToolCall" || item.tool !== "spawnAgent") return;
    const receivers = (item.receiverThreadIds ?? []) as string[];
    for (const childId of receivers) {
      if (this.children.has(childId)) continue;
      const writer = this.host.openSubagent({
        title: firstLine(String(item.prompt ?? "")) || "Subagent",
        toolItemId: item.id,
      });
      mapper.writer.update(item.id, { childThreadId: writer.threadId });
      if (typeof item.prompt === "string")
        writer.add({ type: "user", text: item.prompt, images: [] });
      this.children.set(childId, { mapper: new ItemMapper(writer, this.host.cwd), writer });
      this.provider.addRoute(childId, this);
    }
  }

  private planUpdated(mapper: ItemMapper, params: Record<string, unknown>): void {
    const turnId = String(params.turnId ?? "");
    const plan = (params.plan ?? []) as { step: string; status: string }[];
    const todos = plan.map((entry) => ({
      text: entry.step,
      status:
        entry.status === "completed"
          ? ("completed" as const)
          : entry.status === "inProgress"
            ? ("in_progress" as const)
            : ("pending" as const),
    }));
    const existing = this.planItems.get(turnId);
    if (existing) {
      mapper.writer.update(existing, { todos, output: String(params.explanation ?? "") });
      return;
    }
    const item = mapper.writer.add({
      type: "tool",
      kind: "todo",
      name: "update_plan",
      title: "Update the plan",
      input: {},
      output: String(params.explanation ?? ""),
      status: "done",
      todos,
    });
    this.planItems.set(turnId, item.id);
  }

  private endTurn(outcome: Parameters<SessionHost["turnEnded"]>[0]): void {
    this.turn = undefined;
    this.planItems.clear();
    this.host.turnEnded(outcome);
  }

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const controller = new AbortController();
    // The request's id is not passed through, so match "resolved" notices by item id.
    const key = String(params.itemId ?? params.approvalId ?? "");
    if (key) this.prompts.set(key, controller);
    try {
      return await this.answer(method, params, controller.signal);
    } finally {
      if (key) this.prompts.delete(key);
    }
  }

  private async answer(
    method: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown> {
    switch (method) {
      case "item/commandExecution/requestApproval": {
        const command = String(params.command ?? "");
        if (this.allowedCommands.has(command)) return { decision: "acceptForSession" };
        const decision = await this.host.requestApproval(
          {
            kind: "command",
            title: firstLine(shownCommand(command)) || "Run a command",
            detail: shownCommand(command),
            reason: (params.reason as string | undefined) ?? undefined,
            toolItemId: this.toolItem(params.itemId),
          },
          signal,
        );
        if (decision === "allow_session") this.allowedCommands.add(command);
        return { decision: this.codexDecision(decision, signal) };
      }
      case "item/fileChange/requestApproval": {
        if (this.allowEdits) return { decision: "acceptForSession" };
        const item = this.host.items.get(String(params.itemId));
        const changes = item?.type === "tool" ? item.changes : undefined;
        const decision = await this.host.requestApproval(
          {
            kind: "edit",
            title: changes?.map((change) => change.path).join(", ") || "Edit files",
            detail: changes?.map((change) => change.path).join("\n") ?? "",
            reason: (params.reason as string | undefined) ?? undefined,
            changes,
            toolItemId: this.toolItem(params.itemId),
          },
          signal,
        );
        if (decision === "allow_session") this.allowEdits = true;
        return { decision: this.codexDecision(decision, signal) };
      }
      case "item/permissions/requestApproval": {
        const decision = await this.host.requestApproval(
          {
            kind: "tool",
            title: "Give Codex more access",
            detail: JSON.stringify(params.permissions ?? {}, null, 2),
            reason: (params.reason as string | undefined) ?? undefined,
          },
          signal,
        );
        return {
          permissions: decision === "deny" ? {} : (params.permissions ?? {}),
          scope: decision === "allow_session" ? "session" : "turn",
        };
      }
      case "item/tool/requestUserInput": {
        const raw = (params.questions ?? []) as {
          id: string;
          header?: string;
          question: string;
          options?: { label: string; description?: string }[] | null;
        }[];
        const questions: Question[] = raw.map((entry) => ({
          id: entry.id,
          header: entry.header ?? "",
          question: entry.question,
          options: (entry.options ?? []).map((option) => ({
            label: option.label,
            description: option.description,
          })),
          multiSelect: false,
        }));
        const answers = await this.host.requestAnswers(questions, signal);
        const result: Record<string, { answers: string[] }> = {};
        for (const question of questions)
          result[question.id] = { answers: answers?.[question.id] ?? [] };
        return { answers: result };
      }
      case "mcpServer/elicitation/request":
        return { action: "decline" };
      case "execCommandApproval":
      case "applyPatchApproval": {
        const command = Array.isArray(params.command) ? (params.command as string[]).join(" ") : "";
        const decision = await this.host.requestApproval(
          {
            kind: method === "execCommandApproval" ? "command" : "edit",
            title: firstLine(command) || "Change files",
            detail: command || JSON.stringify(params.fileChanges ?? {}, null, 2),
            reason: (params.reason as string | undefined) ?? undefined,
          },
          signal,
        );
        return {
          decision:
            decision === "allow"
              ? "approved"
              : decision === "allow_session"
                ? "approved_for_session"
                : signal.aborted
                  ? "abort"
                  : "denied",
        };
      }
      case "item/tool/call": {
        const answer: ToolAnswer =
          params.tool === MOVE_TASK
            ? moveTask(this.host, params.arguments)
            : params.tool === ADD_IDEA
              ? addIdea(this.host, params.arguments)
              : params.tool === SHOW_PAGE
                ? showPage(this.host, params.arguments)
                : { ok: false, text: `dodocode has no tool named ${String(params.tool)}.` };
        return { contentItems: [{ type: "inputText", text: answer.text }], success: answer.ok };
      }
      default:
        throw new RpcError(-32601, `dodocode does not handle ${method}.`);
    }
  }

  private codexDecision(decision: "allow" | "allow_session" | "deny", signal: AbortSignal): string {
    if (decision === "allow") return "accept";
    if (decision === "allow_session") return "acceptForSession";
    return signal.aborted || this.turn?.interrupted ? "cancel" : "decline";
  }

  private toolItem(itemId: unknown): string | undefined {
    const id = typeof itemId === "string" ? itemId : undefined;
    return id && this.host.items.get(id) ? id : undefined;
  }
}
