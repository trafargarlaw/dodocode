// The conversations Claude Code had in other apps: its terminal, VS Code, T3 Code, any app built
// on the Agent SDK. Each is a JSONL file under ~/.claude/projects, read here into a thread's
// items the way a live session writes them, at the times things happened.

import { existsSync, readFileSync } from "node:fs";
import { open, readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { forkSession, getSessionInfo, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ImageRef, Question } from "@dodocode/protocol";

import type { History, HistoryWriter } from "../history";
import { errorText, log } from "../util";
import { compactNotice, Transcript, type TranscriptHooks } from "./claude-transcript";
import type { FoundSession, SessionRead, SessionSource } from "./types";

/** One line of a session's file: only the fields read here. */
export interface Line {
  type: string;
  subtype?: string;
  uuid?: string;
  parentUuid?: string | null;
  /** Set on a compaction's line, whose `parentUuid` is null: the line it follows. */
  logicalParentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  isApiErrorMessage?: boolean;
  timestamp?: string;
  message?: {
    id?: string;
    model?: string;
    content?: unknown;
    stop_reason?: string | null;
    usage?: Record<string, unknown>;
  };
  toolUseResult?: unknown;
  requestedModel?: string;
  effort?: string;
  /** On a prompt: who started its turn, `task_notification` for a background task's news. */
  turnOrigin?: string;
  entrypoint?: string;
  cwd?: string;
  attachment?: { type?: string; prompt?: unknown; commandMode?: string };
  compactMetadata?: { trigger?: string; preTokens?: number; postTokens?: number };
  totalCostUSD?: number;
  prNumber?: number;
  prUrl?: string;
  prRepository?: string;
}

interface Block {
  type: string;
  id?: string;
  name?: string;
  input?: unknown;
  text?: string;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
  source?: { type?: string; media_type?: string; data?: string };
}

/** The apps Claude Code records itself started by, as the person knows them. */
export function appOf(entrypoint: string | undefined): string {
  if (!entrypoint || entrypoint === "cli") return "Claude Code";
  if (entrypoint === "claude-vscode") return "VS Code";
  if (entrypoint === "t3-code") return "T3 Code";
  if (entrypoint === "claude-desktop") return "Claude Desktop";
  if (entrypoint.startsWith("sdk")) return "an Agent SDK app";
  return entrypoint;
}

/** Where Claude Code keeps a folder of sessions for each folder it worked in. */
function projectsDir(): string {
  return join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
}

export function parseLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as Line);
    } catch {
      // A line cut off as the file was written.
    }
  }
  return lines;
}

/**
 * The conversation as it stands: from its latest message back to its first, by each line's
 * parent. Lines on branches left behind, as when a message was edited and sent again, are not
 * in it. A compaction's line has no parent and names the line it follows instead.
 */
export function chainOf(lines: readonly Line[], sidechain = false): Line[] {
  const byUuid = new Map<string, Line>();
  let leaf: Line | undefined;
  for (const line of lines) {
    if (line.uuid) byUuid.set(line.uuid, line);
    const message = line.type === "user" || line.type === "assistant";
    if (message && Boolean(line.isSidechain) === sidechain) leaf = line;
  }
  const chain: Line[] = [];
  const seen = new Set<string>();
  for (let line = leaf; line?.uuid && !seen.has(line.uuid);) {
    seen.add(line.uuid);
    chain.push(line);
    const parent = line.parentUuid ?? line.logicalParentUuid;
    line = parent ? byUuid.get(parent) : undefined;
  }
  return chain.toReversed();
}

/** What the person's line says, once the app's own wrapping is taken off. */
type Said =
  | { kind: "prompt"; text: string; images: ImageRef[] }
  /** What a local slash command, such as /context, printed. */
  | { kind: "output"; text: string }
  /** News of a background task, which starts a turn of the agent's own. */
  | { kind: "notification"; text: string }
  | { kind: "interrupt" }
  | { kind: "none" };

/** Context an app adds to a message, which the person did not write. */
const ADDED_CONTEXT = /^\s*<(system-reminder|ide_selection|ide_opened_file|ide_diagnostics)>/;
const INTERRUPTED = /^\[Request interrupted by user/;
const DENIED =
  /^(The user doesn't want to proceed|The person declined this|Permission to use .* (has been )?denied)/;

function textBlocks(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return Array.isArray(content) ? (content as Block[]) : [];
}

function tagged(text: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return match ? match[1]!.trim() : undefined;
}

function plain(text: string): string {
  // oxlint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

/** The text of a prompt a queued message or a notification carries. */
function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  return textBlocks(prompt)
    .filter((block) => block.type === "text")
    .map((block) => block.text ?? "")
    .join("\n");
}

/** How Claude Code recorded an AskUserQuestion call's questions. */
interface AskInput {
  questions?: {
    question: string;
    header?: string;
    options?: { label: string; description?: string }[];
    multiSelect?: boolean;
  }[];
}

export function questionsOf(input: AskInput): Question[] {
  return (input.questions ?? []).map((entry, index) => ({
    id: String(index),
    header: entry.header ?? "",
    question: entry.question,
    options: (entry.options ?? []).map((option) => ({
      label: option.label,
      description: option.description,
    })),
    multiSelect: Boolean(entry.multiSelect),
  }));
}

/**
 * The person's answers by question id, from the answers Claude Code kept by question text. A
 * multiple choice joins its labels with commas; words that are no label are the person's own.
 */
export function answersOf(
  questions: readonly Question[],
  byText: Record<string, string>,
): Record<string, string[]> {
  const answers: Record<string, string[]> = {};
  for (const question of questions) {
    const answer = byText[question.question];
    if (!answer) continue;
    const labels = new Set(question.options.map((option) => option.label));
    const parts = answer.split(", ");
    answers[question.id] =
      labels.has(answer) || !question.multiSelect || !parts.every((part) => labels.has(part))
        ? [answer]
        : parts;
  }
  return answers;
}

/** A conversation's lines, and the files of the subagents it started, to read it from. */
export interface SessionFiles {
  lines: Line[];
  /** The lines of the subagent a tool call started, when its file is there. */
  subagent(toolId: string, agentId: string | undefined): Line[] | undefined;
}

/**
 * Reads a Claude conversation into `history`: its turns, what the person said in each, and
 * what the agent did, with its subagents' work in threads of their own.
 */
export class ClaudeReader implements TranscriptHooks {
  private history: History;
  private files: SessionFiles;
  private cwd: string;
  /** The clock of the conversation being read now: the main one or a subagent's. */
  private clock = { at: 0 };
  private denied = new Set<string>();
  /** AskUserQuestion calls, by tool call, with their questions' item. */
  private asks = new Map<
    string,
    { writer: HistoryWriter; itemId: string; questions: Question[] }
  >();
  /** The agent ids tool calls that started a subagent gave back. */
  private agentIds = new Map<string, string>();
  private writers: HistoryWriter[] = [];
  private links: { at: number; text: string }[] = [];

  constructor(history: History, files: SessionFiles, cwd: string) {
    this.history = history;
    this.files = files;
    this.cwd = cwd;
    const seen = new Set<string>();
    for (const line of files.lines) {
      if (line.type !== "pr-link" || !line.prUrl || seen.has(line.prUrl)) continue;
      seen.add(line.prUrl);
      const where = line.prRepository ? ` in ${line.prRepository}` : "";
      this.links.push({
        at: line.timestamp ? Date.parse(line.timestamp) : 0,
        text: `Linked pull request #${line.prNumber}${where}: ${line.prUrl}`,
      });
    }
    this.links.sort((a, b) => a.at - b.at);
  }

  read(): SessionRead {
    const lines = this.files.lines;
    const main = this.history.main;
    const chain = chainOf(lines);
    // The tool calls whose result named the subagent they started, before any is read.
    for (const line of lines) this.noteAgentId(line);
    this.walk(chain, main, new Transcript(main, this.cwd, this), false);
    this.showLinks(main, Infinity);
    let model: string | undefined;
    let effort: string | undefined;
    for (const line of chain) {
      if (line.type !== "assistant" || line.message?.model === "<synthetic>") continue;
      model = line.requestedModel ?? line.message?.model ?? model;
      effort = line.effort ?? effort;
    }
    const cost = lines.findLast((line) => line.type === "cost-state")?.totalCostUSD;
    return {
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(cost !== undefined ? { costUsd: cost } : {}),
    };
  }

  // TranscriptHooks

  subagentStarted(toolId: string, title: string, parent: Transcript): void {
    const lines = this.files.subagent(toolId, this.agentIds.get(toolId));
    if (!lines) return;
    const writer = this.history.child(parent.writer as HistoryWriter, toolId, title);
    const outer = this.clock;
    const chain = chainOf(lines, true);
    const first = chain.find((line) => line.timestamp);
    writer.clock.at = first?.timestamp ? Date.parse(first.timestamp) : outer.at;
    for (const line of lines) this.noteAgentId(line);
    this.walk(chain, writer, new Transcript(writer, this.cwd, this, true), true);
    this.clock = outer;
  }

  subagentReturned(): void {}

  toolDenied(toolId: string): boolean {
    return this.denied.has(toolId);
  }

  keepImage(data: string, mime: string): ImageRef | undefined {
    return this.history.keepImage(data, mime);
  }

  now(): number {
    return this.clock.at;
  }

  // Reading

  private noteAgentId(line: Line): void {
    const result = line.toolUseResult as { agentId?: unknown } | undefined;
    if (typeof result?.agentId !== "string") return;
    for (const block of textBlocks(line.message?.content)) {
      if (block.type === "tool_result" && block.tool_use_id) {
        this.agentIds.set(block.tool_use_id, result.agentId);
      }
    }
  }

  /** Reads one conversation's lines into its thread, turn by turn. */
  private walk(
    chain: readonly Line[],
    writer: HistoryWriter,
    transcript: Transcript,
    subagent: boolean,
  ): void {
    this.clock = writer.clock;
    this.writers.push(writer);
    // The message that ended the turn: a later one starts a turn of the agent's own.
    let ended: string | undefined;
    let interrupted = false;
    let failed: string | undefined;
    let lastAt = writer.clock.at;
    let inputTokens = 0;
    let outputTokens = 0;
    const counted = new Set<string>();

    const end = () => {
      if (!writer.inTurn) return;
      const status = interrupted
        ? "interrupted"
        : failed
          ? "failed"
          : ended !== undefined
            ? "completed"
            : "interrupted";
      writer.endTurn(status, lastAt, {
        error: status === "failed" ? failed : undefined,
        inputTokens: inputTokens || undefined,
        outputTokens: outputTokens || undefined,
      });
      transcript.endTurn();
      ended = undefined;
      interrupted = false;
      failed = undefined;
      inputTokens = 0;
      outputTokens = 0;
    };
    const begin = (byAgent: boolean) => {
      end();
      writer.startTurn(byAgent);
    };
    if (subagent) writer.startTurn(true);

    for (const line of chain) {
      const at = line.timestamp ? Date.parse(line.timestamp) : Number.NaN;
      if (!Number.isNaN(at)) writer.clock.at = at;
      if (!subagent) this.showLinks(writer, writer.clock.at);
      switch (line.type) {
        case "assistant": {
          const message = line.message;
          if (!message) break;
          if (!writer.inTurn || (ended !== undefined && message.id !== ended)) begin(true);
          if (message.id && !counted.has(message.id)) {
            counted.add(message.id);
            const usage = message.usage ?? {};
            const count = (key: string) => (typeof usage[key] === "number" ? usage[key] : 0);
            inputTokens +=
              count("input_tokens") +
              count("cache_read_input_tokens") +
              count("cache_creation_input_tokens");
            outputTokens += count("output_tokens");
          }
          if (message.model === "<synthetic>") {
            // A reply no model wrote: what a slash command printed, or an error.
            const text = transcript.textOf(message.content);
            if (text && line.isApiErrorMessage) {
              writer.add({ type: "notice", level: "error", text });
              failed = text;
            } else if (text) {
              writer.add({ type: "assistant", text, streaming: false });
            }
          } else {
            this.asked(writer, message.content);
            transcript.handle({ type: "assistant", message } as unknown as SDKMessage);
          }
          if (message.stop_reason === "end_turn") ended = message.id ?? "";
          lastAt = writer.clock.at;
          break;
        }
        case "user": {
          if (line.isMeta || line.isCompactSummary) break;
          const content = line.message?.content;
          const blocks = textBlocks(content);
          if (blocks.some((block) => block.type === "tool_result")) {
            if (!writer.inTurn) begin(true);
            this.answered(blocks, line.toolUseResult);
            transcript.handle({
              type: "user",
              message: line.message,
              tool_use_result: line.toolUseResult,
              parent_tool_use_id: null,
            } as unknown as SDKMessage);
            if (
              blocks.some((block) => block.type === "text" && INTERRUPTED.test(block.text ?? ""))
            ) {
              interrupted = true;
            }
            lastAt = writer.clock.at;
            break;
          }
          const said = this.said(content, line);
          if (said.kind === "interrupt") {
            interrupted = true;
            lastAt = writer.clock.at;
          } else if (said.kind === "notification") {
            this.notified(said.text);
            if (!writer.inTurn || ended !== undefined) begin(true);
          } else if (said.kind === "output") {
            if (!writer.inTurn) begin(false);
            if (said.text) writer.add({ type: "assistant", text: said.text, streaming: false });
            ended ??= "";
            lastAt = writer.clock.at;
          } else if (said.kind === "prompt") {
            if (subagent) {
              // The subagent's task, which its transcript shows as its first message.
              transcript.handle({ type: "user", message: line.message } as unknown as SDKMessage);
            } else {
              begin(false);
              writer.add({ type: "user", text: said.text, images: said.images });
            }
            lastAt = writer.clock.at;
          }
          break;
        }
        case "attachment": {
          const attachment = line.attachment;
          if (attachment?.type !== "queued_command") break;
          const text = promptText(attachment.prompt).trim();
          const mode = attachment.commandMode;
          if (mode === "task-notification" || text.startsWith("<task-notification>")) {
            this.notified(text);
            break;
          }
          if ((mode && mode !== "prompt") || !text) break;
          // Sent while the agent worked, it went into the running turn.
          if (writer.inTurn && ended === undefined) {
            writer.add({ type: "user", text, images: [], steered: true });
          } else {
            begin(false);
            writer.add({ type: "user", text, images: [] });
          }
          lastAt = writer.clock.at;
          break;
        }
        case "system": {
          if (line.subtype === "compact_boundary") {
            // Compacting as the next message went out: between the turns, not at the end of
            // the last one, whose time it would stretch to now.
            if (ended !== undefined) end();
            const meta = line.compactMetadata;
            writer.add({
              type: "notice",
              level: "info",
              text: compactNotice(meta?.trigger, meta?.preTokens, meta?.postTokens),
            });
          }
          if (writer.inTurn) lastAt = writer.clock.at;
          break;
        }
        default:
          break;
      }
    }
    end();
  }

  /** What a line from the person says, without the wrapping the app put around it. */
  private said(content: unknown, line: Line): Said {
    const blocks = textBlocks(content);
    const texts = blocks
      .filter((block) => block.type === "text" && block.text && !ADDED_CONTEXT.test(block.text))
      .map((block) => block.text!);
    const text = texts.join("\n\n").trim();
    if (INTERRUPTED.test(text)) return { kind: "interrupt" };
    if (line.turnOrigin === "task_notification" || text.startsWith("<task-notification>")) {
      return { kind: "notification", text };
    }
    if (text.includes("<local-command-caveat>")) return { kind: "none" };
    const stdout =
      tagged(text, "local-command-stdout") ??
      tagged(text, "local-command-stderr") ??
      tagged(text, "bash-stdout");
    if (stdout !== undefined) {
      const stderr = tagged(text, "bash-stderr");
      return { kind: "output", text: plain([stdout, stderr].filter(Boolean).join("\n")) };
    }
    const command = tagged(text, "command-name");
    if (command !== undefined) {
      const args = tagged(text, "command-args");
      const name = command.startsWith("/") ? command : `/${command}`;
      return { kind: "prompt", text: args ? `${name} ${args}` : name, images: [] };
    }
    const bash = tagged(text, "bash-input");
    if (bash !== undefined) return { kind: "prompt", text: `!${bash}`, images: [] };
    const images: ImageRef[] = [];
    for (const block of blocks) {
      const source = block.source;
      if (block.type !== "image" || source?.type !== "base64" || !source.data) continue;
      const image = this.history.keepImage(source.data, source.media_type ?? "image/png");
      if (image) images.push(image);
    }
    if (!text && images.length === 0) return { kind: "none" };
    return { kind: "prompt", text, images };
  }

  /** The questions an AskUserQuestion call asked, as the person saw them. */
  private asked(writer: HistoryWriter, content: unknown): void {
    for (const block of textBlocks(content)) {
      if (block.type !== "tool_use" || block.name !== "AskUserQuestion" || !block.id) continue;
      if (this.asks.has(block.id)) continue;
      const questions = questionsOf((block.input ?? {}) as AskInput);
      const item = writer.add({ type: "question", questions, status: "pending" });
      this.asks.set(block.id, { writer, itemId: item.id, questions });
    }
  }

  /** Marks the tool calls the person declined, and keeps the answers to questions. */
  private answered(blocks: readonly Block[], structured: unknown): void {
    for (const block of blocks) {
      if (block.type !== "tool_result" || !block.tool_use_id) continue;
      const output = typeof block.content === "string" ? block.content : promptText(block.content);
      if (block.is_error && DENIED.test(output)) this.denied.add(block.tool_use_id);
      const ask = this.asks.get(block.tool_use_id);
      if (!ask) continue;
      const byText = (structured as { answers?: Record<string, string> } | undefined)?.answers;
      if (block.is_error || !byText) {
        ask.writer.update(ask.itemId, { status: "cancelled" });
      } else {
        ask.writer.update(ask.itemId, {
          status: "answered",
          answers: answersOf(ask.questions, byText),
        });
      }
    }
  }

  /** A background task's news: the tool call that started it is done. */
  private notified(text: string): void {
    const toolId = tagged(text, "tool-use-id");
    const status = tagged(text, "status");
    if (!toolId) return;
    for (const writer of this.writers) {
      const tool = writer.get(toolId);
      if (tool?.type !== "tool" || (!tool.background && tool.status !== "running")) continue;
      writer.update(toolId, {
        background: undefined,
        status: status === "completed" ? "done" : "error",
        endedAt: this.clock.at,
      });
    }
  }

  /** Pull requests the conversation linked by `at`, where they were linked. */
  private showLinks(writer: HistoryWriter, at: number): void {
    while (this.links.length > 0 && this.links[0]!.at <= at) {
      writer.add({ type: "notice", level: "info", text: this.links.shift()!.text });
    }
  }
}

// Files

/** Every session's file, by its id. */
async function sessionFiles(): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const root = projectsDir();
  let folders: string[];
  try {
    folders = await readdir(root);
  } catch {
    return files;
  }
  await Promise.all(
    folders.map(async (folder) => {
      let names: string[];
      try {
        names = await readdir(join(root, folder));
      } catch {
        return;
      }
      for (const name of names) {
        if (name.endsWith(".jsonl")) files.set(name.slice(0, -6), join(root, folder, name));
      }
    }),
  );
  return files;
}

/** The app a session's file says started it, from its first lines. */
async function entrypointOf(file: string | undefined): Promise<string | undefined> {
  if (!file) return undefined;
  let handle;
  try {
    handle = await open(file, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return /"entrypoint":"([^"]+)"/.exec(buffer.subarray(0, bytesRead).toString("utf8"))?.[1];
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

/** The files of the subagents a session started, by the tool call that started each. */
async function subagentFiles(file: string): Promise<SessionFiles["subagent"]> {
  const folder = join(dirname(file), basename(file, ".jsonl"), "subagents");
  const byTool = new Map<string, string>();
  let names: string[] = [];
  try {
    names = await readdir(folder);
  } catch {
    // It started none.
  }
  await Promise.all(
    names
      .filter((name) => name.endsWith(".meta.json"))
      .map(async (name) => {
        try {
          const meta = JSON.parse(await readFile(join(folder, name), "utf8")) as {
            toolUseId?: string;
          };
          const lines = join(folder, name.replace(/\.meta\.json$/, ".jsonl"));
          if (meta.toolUseId && existsSync(lines)) byTool.set(meta.toolUseId, lines);
        } catch {
          // A meta file being written.
        }
      }),
  );
  const cache = new Map<string, Line[]>();
  return (toolId, agentId) => {
    const path =
      byTool.get(toolId) ?? (agentId ? join(folder, `agent-${agentId}.jsonl`) : undefined);
    if (!path || !existsSync(path)) return undefined;
    let lines = cache.get(path);
    if (!lines) {
      lines = parseLines(readFileSync(path, "utf8"));
      cache.set(path, lines);
    }
    return lines;
  };
}

/** Claude Code's conversations, wherever they were started. */
export class ClaudeSessions implements SessionSource {
  private files = new Map<string, string>();

  async list(): Promise<FoundSession[]> {
    const [infos, files] = await Promise.all([listSessions(), sessionFiles()]);
    this.files = files;
    const sessions: FoundSession[] = [];
    // A few files at a time: there can be hundreds.
    for (let start = 0; start < infos.length; start += 32) {
      const batch = infos.slice(start, start + 32);
      const apps = await Promise.all(batch.map((info) => entrypointOf(files.get(info.sessionId))));
      batch.forEach((info, index) => {
        if (!info.cwd) return;
        sessions.push({
          id: info.sessionId,
          title: info.summary,
          ...(info.firstPrompt && info.firstPrompt !== info.summary
            ? { firstPrompt: info.firstPrompt }
            : {}),
          cwd: info.cwd,
          ...(info.gitBranch ? { branch: info.gitBranch } : {}),
          app: appOf(apps[index]),
          ...(info.createdAt ? { createdAt: info.createdAt } : {}),
          updatedAt: info.lastModified,
        });
      });
    }
    return sessions.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(id: string, history: History): Promise<SessionRead> {
    const file = await this.file(id);
    const lines = parseLines(await readFile(file, "utf8"));
    const cwd = lines.findLast((line) => line.cwd)?.cwd ?? dirname(file);
    const reader = new ClaudeReader(history, { lines, subagent: await subagentFiles(file) }, cwd);
    const read = reader.read();
    let title: string | undefined;
    try {
      title = (await getSessionInfo(id))?.summary;
    } catch (error) {
      log("claude", "could not read a session's title", errorText(error));
    }
    return { ...read, ...(title ? { title } : {}) };
  }

  async copy(id: string, cwd: string): Promise<string> {
    const { sessionId } = await forkSession(id, { dir: cwd });
    return sessionId;
  }

  private async file(id: string): Promise<string> {
    let file = this.files.get(id);
    if (!file || !existsSync(file)) {
      this.files = await sessionFiles();
      file = this.files.get(id);
    }
    if (!file) throw new Error("That conversation is gone from Claude Code.");
    return file;
  }
}
