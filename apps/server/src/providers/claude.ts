// Claude, through the Claude Agent SDK. Each thread keeps one Claude Code process with a prompt
// stream that stays open across turns; a new process resumes the same Claude session.

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";

import {
  createSdkMcpServer,
  query as startQuery,
  tool as sdkTool,
  type CanUseTool,
  type ModelInfo,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
  type SlashCommand as ClaudeCommand,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  ImageRef,
  ModelOption,
  Question,
  SlashCommand,
  ThreadSettings,
} from "@dodocode/protocol";

import { AsyncQueue, errorText, log, newId, within } from "../util";
import { appInstructions, appToolsFor } from "./app-tools";
import { ClaudeSessions } from "./claude-sessions";
import { compactNotice, Transcript, type TranscriptHooks } from "./claude-transcript";
import { APP_SERVER, APP_TOOLS, changesForInput, describeTool, relativePath } from "./claude-tools";
import { agentEnv, findOnPath, HOME_BIN } from "./env";
import type {
  Provider,
  ProviderCheck,
  ProviderSession,
  SessionHost,
  SubagentWriter,
  TurnMessage,
} from "./types";

/**
 * The SDK's bundled binary when the app is packaged. The SDK finds it inside app.asar, where it
 * cannot run; electron-builder unpacks it beside the archive. Unset outside a packaged app, where
 * the SDK finds it itself.
 */
function unpackedBundledClaude(): string | undefined {
  try {
    const sdk = import.meta.resolve("@anthropic-ai/claude-agent-sdk");
    const binary = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude${process.platform === "win32" ? ".exe" : ""}`;
    const path = createRequire(sdk).resolve(binary);
    if (!/[\\/]app\.asar[\\/]/.test(path)) return undefined;
    const unpacked = path.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
    return existsSync(unpacked) ? unpacked : undefined;
  } catch {
    return undefined;
  }
}

/** The `claude` executable on PATH. The SDK does no PATH lookup of its own on Windows. */
function claudeOnPath(): string | undefined {
  const found = findOnPath("claude", [HOME_BIN]);
  // A .cmd shim cannot be spawned without a shell, which the SDK does not use.
  return found && !/\.(cmd|bat)$/i.test(found) ? found : undefined;
}

const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];

function modelOption(info: ModelInfo): ModelOption {
  const efforts = info.supportsEffort
    ? (info.supportedEffortLevels ?? EFFORT_ORDER).toSorted(
        (a, b) => EFFORT_ORDER.indexOf(a) - EFFORT_ORDER.indexOf(b),
      )
    : [];
  return {
    id: info.value,
    label: info.displayName,
    description: info.description,
    efforts,
    defaultEffort: efforts.includes("high") ? "high" : efforts.at(-1),
  };
}

/** dodocode's own tools, on a new server for each process: one serves a single connection. */
function appServer(host: SessionHost) {
  return createSdkMcpServer({
    name: APP_SERVER,
    tools: appToolsFor(host.reviewing).map((tool) =>
      sdkTool(
        tool.name,
        tool.description,
        tool.input,
        async (args) => {
          const answer = tool.run(host, args);
          return { content: [{ type: "text", text: answer.text }], isError: !answer.ok };
        },
        { alwaysLoad: true },
      ),
    ),
  });
}

/** A reviewer only reads. Its commands are held to that only by what it is told. */
const REVIEWER_DISALLOWED = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * What the work since the last result cost, from the running total a result carries and the
 * total before it. A smaller total is a new one, as after /clear. A crashed turn's result
 * carries zero, which says nothing, so the total before it stays.
 */
export function costSince(total: number, before: number): { cost: number; total: number } {
  if (total === 0) return { cost: 0, total: before };
  if (total < before) return { cost: total, total };
  return { cost: total - before, total };
}

/**
 * Claude Code's slash commands as the composer offers them: without the ones it says need its
 * terminal, the ones it removed or renamed, and its internal ones.
 */
export function slashCommands(
  commands: ClaudeCommand[],
  terminal: ReadonlySet<string> = new Set(),
): SlashCommand[] {
  return commands
    .filter(
      (command) =>
        !terminal.has(command.name) &&
        !command.name.startsWith("_") &&
        !/^\(removed\)|^Renamed to /.test(command.description),
    )
    .map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
    }));
}

function permissionMode(settings: ThreadSettings): Options["permissionMode"] {
  return settings.access === "full" ? "bypassPermissions" : "default";
}

/** Never yields, so a probe query starts the process without asking the model anything. */
// oxlint-disable-next-line require-yield
async function* silentPrompt(signal: AbortSignal): AsyncGenerator<SDKUserMessage> {
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
}

export class ClaudeProvider implements Provider {
  readonly id = "claude" as const;
  readonly label = "Claude";
  readonly sessions = new ClaudeSessions();
  /** Unset while the SDK's own bundled executable works. */
  executable: string | undefined = process.env.DODOCODE_CLAUDE_PATH || unpackedBundledClaude();

  async check(): Promise<ProviderCheck> {
    const base = { id: this.id, label: this.label, models: [] as ModelOption[] };
    try {
      const result = await this.probe(this.executable);
      return { ...base, status: "ready", ...result };
    } catch (error) {
      const fallback = this.executable ? undefined : claudeOnPath();
      if (fallback) {
        try {
          const result = await this.probe(fallback);
          this.executable = fallback;
          return { ...base, status: "ready", ...result };
        } catch (second) {
          return { ...base, status: "error", message: errorText(second) };
        }
      }
      const message = errorText(error);
      const missing = /ENOENT|not found|no such file/i.test(message);
      return {
        ...base,
        status: missing ? "missing" : "error",
        message: missing ? "Claude Code is not installed." : message,
      };
    }
  }

  private async probe(
    executable: string | undefined,
  ): Promise<{ models: ModelOption[]; commands: SlashCommand[] }> {
    const abort = new AbortController();
    const probe = startQuery({
      prompt: silentPrompt(abort.signal),
      options: {
        cwd: homedir(),
        abortController: abort,
        persistSession: false,
        strictMcpConfig: true,
        mcpServers: {},
        allowedTools: [],
        env: {
          ...agentEnv(),
          ENABLE_CLAUDEAI_MCP_SERVERS: "false",
          CLAUDE_CODE_AUTO_CONNECT_IDE: "0",
        },
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      },
    });
    try {
      const init = await Promise.race([
        probe.initializationResult(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("Claude Code did not start within 60 seconds.")),
            60_000,
          ),
        ),
      ]);
      const models = init.models.filter((model) => model.value !== "default").map(modelOption);
      return { models, commands: slashCommands(init.commands) };
    } finally {
      abort.abort();
      probe.close();
    }
  }

  createSession(host: SessionHost): ProviderSession {
    return new ClaudeSession(host, this.executable);
  }
}

interface SessionTurn {
  /** Started by a message from the person, rather than by Claude on its own. */
  human: boolean;
  steers: number;
  interrupted: boolean;
  sawText: boolean;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
}

class ClaudeSession implements ProviderSession, TranscriptHooks {
  private query: Query | undefined;
  private input: AsyncQueue<SDKUserMessage> | undefined;
  private turn: SessionTurn | undefined;
  private applied: { model: string; effort: string; mode: Options["permissionMode"] } | undefined;
  private root: Transcript;
  /** Transcripts of subagents, by the tool call that started them. */
  private subagents = new Map<string, Transcript>();
  private subagentWriters = new Map<string, SubagentWriter>();
  /** Tool calls by task, for background tasks. */
  private taskTools = new Map<string, string>();
  /** Permission rules the person allowed for this thread, kept across processes. */
  private allowedRules = new Set<string>();
  private allowedTools = new Set<string>();
  private deniedTools = new Set<string>();
  /** The running cost the last result carried. */
  private lastCost = 0;
  /** Slash commands that only work in Claude Code's own terminal. */
  private terminalCommands = new Set<string>();
  private compacting = false;
  private disposed = false;
  private host: SessionHost;
  private executable: string | undefined;

  constructor(host: SessionHost, executable: string | undefined) {
    this.host = host;
    this.executable = executable;
    this.root = new Transcript(host.items, host.cwd, this);
  }

  // ProviderSession

  async startTurn(message: TurnMessage): Promise<void> {
    this.turn = this.newTurn(true);
    await this.ensureProcess();
    await this.applySettings();
    this.input!.push(this.userMessage(message));
  }

  async steer(message: TurnMessage): Promise<boolean> {
    if (!this.query || !this.input || !this.turn) return false;
    // A message sent now cancels foreground tools. Move running subagents to the background first.
    for (const toolId of this.root.runningSubagents()) {
      try {
        await within(this.query.backgroundTasks(toolId), 5000, false);
      } catch (error) {
        log("claude", "could not background subagent", errorText(error));
      }
    }
    if (!this.turn) return false;
    this.turn.steers += 1;
    this.input.push(this.userMessage(message, "now"));
    return true;
  }

  async interrupt(): Promise<void> {
    if (!this.turn) return;
    this.turn.interrupted = true;
    if (!this.query) {
      this.endTurn({ status: "interrupted" });
      return;
    }
    await this.query.interrupt();
  }

  async stopJob(jobId: string): Promise<void> {
    await this.query?.stopTask(jobId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.closeProcess();
  }

  // The process

  private newTurn(human: boolean): SessionTurn {
    return {
      human,
      steers: 0,
      interrupted: false,
      sawText: false,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
    };
  }

  private async ensureProcess(): Promise<void> {
    if (this.query) return;
    const settings = this.host.settings();
    const input = new AsyncQueue<SDKUserMessage>();
    const resume = this.host.resumeId;
    // A resumed session's running cost goes on from what the earlier turns cost.
    this.lastCost = resume ? (this.host.resumeCost ?? 0) : 0;
    const options: Options = {
      cwd: this.host.cwd,
      model: settings.model || undefined,
      ...(settings.effort ? { effort: settings.effort as Options["effort"] } : {}),
      permissionMode: permissionMode(settings),
      allowDangerouslySkipPermissions: true,
      // The SDK warns that full access never consults this, but it still asks it for
      // AskUserQuestion, so questions reach the person in every mode.
      canUseTool: this.canUseTool,
      includePartialMessages: true,
      thinking: { type: "adaptive", display: "summarized" },
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: appInstructions(this.host.reviewing),
      },
      env: agentEnv(),
      mcpServers: { [APP_SERVER]: appServer(this.host) },
      allowedTools: [...APP_TOOLS, ...this.allowedRules],
      ...(this.host.reviewing ? { disallowedTools: REVIEWER_DISALLOWED } : {}),
      ...(resume ? { resume } : {}),
      ...(this.executable ? { pathToClaudeCodeExecutable: this.executable } : {}),
      stderr: (data) => {
        const text = data.trim();
        if (text) log("claude:stderr", text.slice(-2000));
      },
    };
    this.input = input;
    this.query = startQuery({ prompt: input, options });
    this.applied = {
      model: settings.model,
      effort: settings.effort,
      mode: options.permissionMode,
    };
    void this.readLoop(this.query);
    // The window's size, before the first reply says how much of it the conversation takes.
    this.query.initializationResult().then(
      () => this.refreshContext(),
      () => {},
    );
  }

  /** Applies settings that changed since the process started, without restarting it. */
  private async applySettings(): Promise<void> {
    const query = this.query;
    const applied = this.applied;
    if (!query || !applied) return;
    const settings = this.host.settings();
    const mode = permissionMode(settings);
    try {
      if (settings.model && settings.model !== applied.model) {
        await query.setModel(settings.model);
        applied.model = settings.model;
      }
      if (settings.effort !== applied.effort) {
        await query.applyFlagSettings({
          effortLevel: (settings.effort || undefined) as never,
        });
        applied.effort = settings.effort;
      }
      if (mode !== applied.mode) {
        await query.setPermissionMode(mode!);
        applied.mode = mode;
      }
    } catch (error) {
      log("claude", "could not apply settings; restarting the process", errorText(error));
      this.closeProcess();
      await this.ensureProcess();
    }
  }

  private closeProcess(): void {
    const query = this.query;
    this.query = undefined;
    this.input?.end();
    this.input = undefined;
    this.applied = undefined;
    try {
      query?.close();
    } catch (error) {
      log("claude", "close failed", errorText(error));
    }
  }

  private async readLoop(query: Query): Promise<void> {
    try {
      // Read with next() rather than for-await: ending a for-await calls return(), which waits
      // behind a pending read and can hold up an interrupt.
      for (;;) {
        const next = await query.next();
        if (next.done) break;
        if (this.query !== query) break;
        try {
          this.handle(next.value);
        } catch (error) {
          log("claude", "could not handle a message", error);
        }
      }
      if (this.query === query && this.turn) {
        this.endTurn({ status: "failed", error: "Claude Code stopped." });
      }
    } catch (error) {
      if (this.query === query && !this.disposed) {
        const message = errorText(error);
        log("claude", "process failed", message);
        if (this.turn) {
          this.endTurn({
            status: this.turn.interrupted ? "interrupted" : "failed",
            error: message,
          });
        }
      }
    } finally {
      if (this.query === query) this.closeProcess();
    }
  }

  // Messages from Claude Code

  private handle(message: SDKMessage): void {
    switch (message.type) {
      case "system":
        this.handleSystem(message);
        return;
      case "result":
        this.handleResult(message);
        return;
      case "stream_event":
      case "assistant":
      case "user": {
        const parent = message.parent_tool_use_id;
        if (parent) {
          this.subagents.get(parent)?.handle(message);
          return;
        }
        if (message.type !== "user") this.ensureTurn();
        // What a slash command such as /context or /compact printed comes as a reply of its
        // own, which no model wrote.
        if (message.type === "assistant" && message.message.model === "<synthetic>") {
          const text = this.root.textOf(message.message.content);
          if (!text) return;
          if (message.error) {
            this.host.notice("error", text);
          } else {
            this.host.items.add({ type: "assistant", text, streaming: false });
            if (this.turn) this.turn.sawText = true;
          }
          return;
        }
        if (message.type === "assistant" && message.error) {
          this.host.notice("error", this.assistantError(message.error));
        }
        if (message.type === "assistant") this.replyUsed(message);
        const sawText = this.root.handle(message);
        if (sawText && this.turn) this.turn.sawText = true;
        return;
      }
      default:
        return;
    }
  }

  private assistantError(error: string): string {
    switch (error) {
      case "rate_limit":
        return "Claude hit a rate limit.";
      case "authentication_failed":
        return "Claude Code is not signed in. Run `claude` in a terminal and sign in.";
      default:
        return `Claude reported an error: ${error}.`;
    }
  }

  /** Claude started work no one asked for, e.g. after a background task finished. */
  private ensureTurn(): void {
    if (this.turn) return;
    this.turn = this.newTurn(false);
    this.host.agentTurnStarted();
  }

  private handleSystem(message: Extract<SDKMessage, { type: "system" }>): void {
    const event = message as unknown as Record<string, unknown> & { subtype: string };
    switch (event.subtype) {
      case "init":
        if (typeof event.session_id === "string") this.host.saveResumeId(event.session_id);
        if (Array.isArray(event.terminal_slash_commands)) {
          this.terminalCommands = new Set(event.terminal_slash_commands as string[]);
        }
        void this.refreshCommands();
        return;
      case "commands_changed":
        this.commandsFound(event.commands as ClaudeCommand[]);
        return;
      case "status":
        if (event.status === "compacting") {
          this.compacting = true;
          this.host.contextUsed({ compacting: true });
        } else if (this.compacting) {
          this.compacting = false;
          this.host.contextUsed({ compacting: false });
        }
        return;
      case "compact_boundary": {
        const meta = event.compact_metadata as
          | { trigger?: string; pre_tokens?: number; post_tokens?: number }
          | undefined;
        this.host.notice("info", compactNotice(meta?.trigger, meta?.pre_tokens, meta?.post_tokens));
        this.compacting = false;
        this.host.contextUsed({
          compacting: false,
          ...(meta?.post_tokens ? { used: meta.post_tokens } : {}),
        });
        void this.refreshContext();
        return;
      }
      case "api_retry": {
        const attempt = event.attempt as number | undefined;
        const max = event.max_retries as number | undefined;
        if (attempt === 1 || attempt === max) {
          this.host.notice(
            "warning",
            `The API request failed; retrying${attempt && max ? ` (attempt ${attempt} of ${max})` : ""}.`,
          );
        }
        return;
      }
      case "task_started":
        this.taskStarted(event);
        return;
      case "task_updated":
        this.taskUpdated(event);
        return;
      case "task_notification":
        this.taskEnded(event);
        return;
      default:
        return;
    }
  }

  private handleResult(message: Extract<SDKMessage, { type: "result" }>): void {
    const turn = this.turn;
    if (!turn) return;
    // A result from a turn Claude started for a background task belongs to that turn only.
    if (turn.human && message.origin && message.origin.kind !== "human") return;
    const usage = message.usage as unknown as Record<string, number | undefined>;
    turn.inputTokens +=
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0);
    turn.outputTokens += usage.output_tokens ?? 0;
    const spent = costSince(message.total_cost_usd, this.lastCost);
    this.lastCost = spent.total;
    this.host.saveResumeCost(spent.total);
    turn.costUsd += spent.cost;

    const aborted =
      message.terminal_reason === "aborted_streaming" ||
      message.terminal_reason === "aborted_tools";
    // A steer ends the part of the turn it cut off with its own result. The turn goes on.
    if (aborted && turn.steers > 0 && !turn.interrupted) {
      turn.steers -= 1;
      return;
    }

    let status: "completed" | "interrupted" | "failed";
    let error: string | undefined;
    if (turn.interrupted || aborted) {
      status = "interrupted";
    } else if (
      message.subtype === "success" &&
      !message.is_error &&
      message.api_error_status !== 429 &&
      message.api_error_status !== 529
    ) {
      status = "completed";
      if (!turn.sawText && message.result.trim()) {
        this.host.items.add({ type: "assistant", text: message.result, streaming: false });
      }
    } else {
      status = "failed";
      const errors =
        message.subtype === "success"
          ? [message.result]
          : message.errors.filter((text) => !text.startsWith("[ede_diagnostic]"));
      error = errors.join("\n").trim() || "Claude stopped with an error.";
    }
    if (!turn.human && status === "completed" && message.num_turns === 0) {
      // Claude looked at a finished task and had nothing to say.
    }
    this.endTurn({
      status,
      error,
      costUsd: turn.costUsd || undefined,
      inputTokens: turn.inputTokens || undefined,
      outputTokens: turn.outputTokens || undefined,
    });
    // A command such as /autocompact or /compact changes what the context holds or allows.
    void this.refreshContext();
  }

  private endTurn(outcome: Parameters<SessionHost["turnEnded"]>[0]): void {
    this.turn = undefined;
    this.root.endTurn();
    this.host.turnEnded(outcome);
  }

  // Background tasks and subagents

  private taskStarted(event: Record<string, unknown>): void {
    const taskId = event.task_id as string;
    const toolId = event.tool_use_id as string | undefined;
    const taskType = (event.task_type as string | undefined) ?? "";
    if (toolId) this.taskTools.set(taskId, toolId);
    if (!event.is_backgrounded) return;
    this.backgroundTask(taskId, toolId, taskType, event.description as string | undefined);
  }

  private backgroundTask(
    taskId: string,
    toolId: string | undefined,
    taskType: string,
    description: string | undefined,
  ): void {
    const tool = toolId ? this.findTool(toolId) : undefined;
    const kind =
      taskType === "local_bash"
        ? tool?.name === "Monitor"
          ? "monitor"
          : "command"
        : /agent|teammate|workflow/.test(taskType)
          ? "subagent"
          : "other";
    this.host.jobStarted({
      id: taskId,
      kind,
      title: description || tool?.title || "Background task",
      status: "running",
      toolItemId: toolId,
      startedAt: Date.now(),
    });
    if (toolId) this.writerFor(toolId)?.update(toolId, { background: true, status: "running" });
  }

  private taskUpdated(event: Record<string, unknown>): void {
    const taskId = event.task_id as string;
    const patch = (event.patch ?? {}) as { is_backgrounded?: boolean; description?: string };
    if (patch.is_backgrounded) {
      this.backgroundTask(taskId, this.taskTools.get(taskId), "local_agent", patch.description);
    }
  }

  private taskEnded(event: Record<string, unknown>): void {
    const taskId = event.task_id as string;
    const toolId = (event.tool_use_id as string | undefined) ?? this.taskTools.get(taskId);
    const status = event.status as "completed" | "failed" | "stopped";
    const summary = (event.summary as string | undefined) || undefined;
    this.host.jobEnded(taskId, { status, summary });
    if (!toolId) return;
    const writer = this.writerFor(toolId);
    const tool = writer?.get(toolId);
    if (writer && tool?.type === "tool" && (tool.background || tool.status === "running")) {
      writer.update(toolId, {
        background: undefined,
        status: status === "completed" ? "done" : "error",
        endedAt: Date.now(),
      });
    }
    this.subagentWriters.get(toolId)?.finish(status, summary);
  }

  private findTool(toolId: string): { name: string; title: string } | undefined {
    const tool = this.writerFor(toolId)?.get(toolId);
    return tool?.type === "tool" ? tool : undefined;
  }

  /** The writer of the thread that holds a tool call. */
  private writerFor(toolId: string) {
    if (this.root.hasTool(toolId)) return this.host.items;
    for (const transcript of this.subagents.values()) {
      if (transcript.hasTool(toolId)) return transcript.writer;
    }
    return undefined;
  }

  // TranscriptHooks

  subagentStarted(toolId: string, title: string, parent: Transcript): void {
    const writer = this.host.openSubagent({ title, toolItemId: toolId });
    parent.writer.update(toolId, { childThreadId: writer.threadId });
    this.subagentWriters.set(toolId, writer);
    this.subagents.set(toolId, new Transcript(writer, this.host.cwd, this, true));
  }

  subagentReturned(toolId: string, isError: boolean, background: boolean): void {
    if (background) return;
    this.subagentWriters.get(toolId)?.finish(isError ? "failed" : "completed");
  }

  toolDenied(toolId: string): boolean {
    return this.deniedTools.has(toolId);
  }

  keepImage(data: string, mime: string): ImageRef | undefined {
    return this.host.keepImage(data, mime);
  }

  now(): number {
    return Date.now();
  }

  // Context and commands

  /** Measures how full the context is, as Claude Code counts it. */
  private async refreshContext(): Promise<void> {
    const query = this.query;
    if (!query) return;
    try {
      const usage = await within(
        query.getContextUsage({ detail: "summary" }).then(
          (value) => value,
          () => undefined,
        ),
        10_000,
        undefined,
      );
      if (!usage || this.query !== query) return;
      this.host.contextUsed({
        used: usage.totalTokens,
        window: usage.maxTokens,
        autoCompactAt: usage.isAutoCompactEnabled ? usage.autoCompactThreshold : undefined,
      });
    } catch (error) {
      log("claude", "could not read the context usage", errorText(error));
    }
  }

  /** The tokens a reply from the model took up, which is what the context holds now. */
  private replyUsed(message: Extract<SDKMessage, { type: "assistant" }>): void {
    const usage = message.message.usage as unknown as Record<string, number | undefined> | null;
    if (!usage) return;
    const used =
      (usage.input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.output_tokens ?? 0);
    if (used > 0) this.host.contextUsed({ used });
  }

  private async refreshCommands(): Promise<void> {
    const query = this.query;
    if (!query) return;
    try {
      const commands = await within(
        query.supportedCommands().then(
          (value) => value,
          () => undefined,
        ),
        10_000,
        undefined,
      );
      if (commands && this.query === query) this.commandsFound(commands);
    } catch (error) {
      log("claude", "could not list the slash commands", errorText(error));
    }
  }

  private commandsFound(commands: ClaudeCommand[]): void {
    this.host.commandsFound(slashCommands(commands, this.terminalCommands));
  }

  // Asking the person

  private canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
    const toolUseID = options.toolUseID;
    if (toolName === "AskUserQuestion") return this.askQuestions(input, options.signal, toolUseID);
    if (this.allowedTools.has(toolName) && toolName !== "Bash") {
      return { behavior: "allow", updatedInput: input, toolUseID };
    }
    const described = describeTool(toolName, input, this.host.cwd);
    const kind =
      described.kind === "command" ? "command" : described.kind === "edit" ? "edit" : "tool";
    const detail =
      kind === "command"
        ? String(input.command ?? "")
        : kind === "edit"
          ? relativePath(String(input.file_path ?? input.notebook_path ?? ""), this.host.cwd)
          : JSON.stringify(input, null, 2);
    const decision = await this.host.requestApproval(
      {
        kind,
        title: options.title ?? described.title,
        detail,
        reason: options.decisionReason ?? options.description,
        changes: kind === "edit" ? changesForInput(toolName, input, this.host.cwd) : undefined,
        toolItemId: this.writerFor(toolUseID) === this.host.items ? toolUseID : undefined,
        sessionOption: !options.suppressAlwaysAllowRule,
      },
      options.signal,
    );
    if (decision === "deny") {
      this.deniedTools.add(toolUseID);
      return {
        behavior: "deny",
        message: options.signal.aborted
          ? "The person stopped the turn."
          : "The person declined this.",
        toolUseID,
        decisionClassification: "user_reject",
        ...(options.signal.aborted ? { interrupt: true } : {}),
      };
    }
    if (decision === "allow") {
      return {
        behavior: "allow",
        updatedInput: input,
        toolUseID,
        decisionClassification: "user_temporary",
      };
    }
    const updates: PermissionUpdate[] = options.suggestions?.length
      ? options.suggestions.map(
          (suggestion) => ({ ...suggestion, destination: "session" }) as PermissionUpdate,
        )
      : [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }];
    for (const update of updates) {
      if (update.type !== "addRules" || update.behavior !== "allow") continue;
      for (const rule of update.rules) {
        this.allowedRules.add(
          rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName,
        );
        if (!rule.ruleContent) this.allowedTools.add(rule.toolName);
      }
    }
    return {
      behavior: "allow",
      updatedInput: input,
      toolUseID,
      decisionClassification: "user_permanent",
      updatedPermissions: updates,
    };
  };

  private async askQuestions(
    input: Record<string, unknown>,
    signal: AbortSignal,
    toolUseID: string,
  ): Promise<PermissionResult> {
    const raw = (input.questions ?? []) as {
      question: string;
      header?: string;
      options?: { label: string; description?: string }[];
      multiSelect?: boolean;
    }[];
    const questions: Question[] = raw.map((entry, index) => ({
      id: String(index),
      header: entry.header ?? "",
      question: entry.question,
      options: (entry.options ?? []).map((option) => ({
        label: option.label,
        description: option.description,
      })),
      multiSelect: Boolean(entry.multiSelect),
    }));
    const answers = await this.host.requestAnswers(questions, signal);
    if (!answers) {
      return { behavior: "deny", message: "The person dismissed the questions.", toolUseID };
    }
    const byQuestion: Record<string, string> = {};
    questions.forEach((question, index) => {
      const chosen = answers[question.id] ?? [];
      if (chosen.length > 0) byQuestion[raw[index]!.question] = chosen.join(", ");
    });
    return {
      behavior: "allow",
      updatedInput: { ...input, answers: byQuestion },
      toolUseID,
    };
  }

  // Prompts

  private userMessage(message: TurnMessage, priority?: "now"): SDKUserMessage {
    const content: unknown[] = [];
    for (const image of message.images) {
      try {
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: image.mime,
            data: readFileSync(image.path).toString("base64"),
          },
        });
      } catch (error) {
        log("claude", "could not read an image", errorText(error));
      }
    }
    // The text goes last: Claude expands a /command only at the start of the last text block.
    content.push({ type: "text", text: message.text || " " });
    return {
      type: "user",
      message: { role: "user", content: content as never },
      parent_tool_use_id: null,
      uuid: newId() as never,
      ...(priority ? { priority } : {}),
    } as SDKUserMessage;
  }
}
