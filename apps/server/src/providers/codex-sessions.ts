// The conversations Codex had in other apps, through its app-server: listed, read into a
// thread's history, and copied.

import type { ImageRef } from "@dodocode/protocol";

import { dataUrl, type History, type HistoryWriter, type TurnStatus } from "../history";
import { type CodexItem, firstLine, ItemMapper } from "./codex-items";
import type { FoundSession, SessionRead, SessionSource } from "./types";

type Request = (method: string, params: Record<string, unknown>) => Promise<unknown>;

interface CodexThread {
  id: string;
  preview: string;
  name?: string | null;
  cwd: string;
  /** Seconds. */
  createdAt: number;
  updatedAt: number;
  originator: string;
  ephemeral?: boolean;
  parentThreadId?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
  gitInfo?: { branch?: string | null } | null;
}

interface CodexTurn {
  id: string;
  items: CodexItem[];
  status: string;
  error?: { message?: string } | null;
  /** Seconds. */
  startedAt?: number | null;
  completedAt?: number | null;
}

/** dodocode's own threads, which show as threads already. */
const OURS = "dodocode";

/** Where people start Codex conversations. Subagents and one-off `codex exec` runs are left out. */
const SOURCES = ["cli", "vscode", "appServer"];

/** How many conversations to list, newest first. */
const LIMIT = 300;

/** The apps Codex names as a conversation's originator, by the names people know them by. */
const APPS: Record<string, string> = {
  codex_cli_rs: "Codex CLI",
  codex_vscode: "VS Code",
  codex_desktop: "Codex Desktop",
  t3code_desktop: "T3 Code",
};

export function codexApp(originator: string): string {
  return APPS[originator.toLowerCase()] ?? originator;
}

const seconds = (value: number | null | undefined) =>
  typeof value === "number" && value > 0 ? value * 1000 : undefined;

const millis = (value: unknown) => (typeof value === "number" && value > 0 ? value : undefined);

export class CodexSessions implements SessionSource {
  private server: () => Promise<{ request: Request }>;

  constructor(server: () => Promise<{ request: Request }>) {
    this.server = server;
  }

  private async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const server = await this.server();
    return server.request(method, params);
  }

  async list(): Promise<FoundSession[]> {
    const found: FoundSession[] = [];
    let cursor: string | null = null;
    do {
      const page = (await this.request("thread/list", {
        limit: 100,
        sourceKinds: SOURCES,
        sortKey: "updated_at",
        ...(cursor ? { cursor } : {}),
      })) as { data: CodexThread[]; nextCursor: string | null };
      for (const thread of page.data) {
        if (thread.originator === OURS || thread.ephemeral || thread.parentThreadId) continue;
        if (!thread.cwd) continue;
        found.push({
          id: thread.id,
          title: thread.name || firstLine(thread.preview) || "Untitled",
          firstPrompt: thread.preview || undefined,
          cwd: thread.cwd,
          branch: thread.gitInfo?.branch ?? undefined,
          app: codexApp(thread.originator),
          createdAt: seconds(thread.createdAt),
          updatedAt: seconds(thread.updatedAt) ?? 0,
        });
      }
      cursor = page.nextCursor;
    } while (cursor && found.length < LIMIT);
    return found.toSorted((a, b) => b.updatedAt - a.updatedAt);
  }

  async read(id: string, history: History): Promise<SessionRead> {
    const { thread } = (await this.request("thread/read", {
      threadId: id,
      includeTurns: false,
    })) as { thread: CodexThread };
    await new CodexReader(this, history, thread.cwd).thread(id, history.main);
    return {
      title: thread.name || firstLine(thread.preview) || undefined,
      model: thread.model ?? undefined,
      effort: thread.reasoningEffort ?? undefined,
    };
  }

  async copy(id: string, cwd: string): Promise<string> {
    const result = (await this.request("thread/fork", { threadId: id, cwd })) as {
      thread: { id: string };
    };
    return result.thread.id;
  }

  /** Every turn of a thread, oldest first. */
  async turns(threadId: string): Promise<CodexTurn[]> {
    const turns: CodexTurn[] = [];
    let cursor: string | null = null;
    do {
      const page = (await this.request("thread/turns/list", {
        threadId,
        limit: 100,
        sortDirection: "asc",
        itemsView: "full",
        ...(cursor ? { cursor } : {}),
      })) as { data: CodexTurn[]; nextCursor: string | null };
      turns.push(...page.data);
      cursor = page.nextCursor;
    } while (cursor);
    return turns;
  }
}

/** Reads one Codex conversation, and the subagents it started, into a history. */
export class CodexReader {
  private source: Pick<CodexSessions, "turns">;
  private history: History;
  private cwd: string;
  private read = new Set<string>();

  constructor(source: Pick<CodexSessions, "turns">, history: History, cwd: string) {
    this.source = source;
    this.history = history;
    this.cwd = cwd;
  }

  /**
   * Writes a thread's turns. A subagent's thread may not hold the prompt it was started with,
   * which then comes from the tool call that started it.
   */
  async thread(threadId: string, writer: HistoryWriter, prompt?: string): Promise<TurnStatus> {
    this.read.add(threadId);
    const mapper = new ItemMapper(writer, this.cwd, () => writer.clock.at);
    let last: TurnStatus = "completed";
    let prompted = prompt === undefined;
    for (const turn of await this.source.turns(threadId)) {
      writer.clock.at = seconds(turn.startedAt) ?? writer.clock.at;
      const asked = turn.items.some((item) => item.type === "userMessage");
      writer.startTurn(!asked && prompted);
      if (!prompted) {
        prompted = true;
        if (!asked) writer.add({ type: "user", text: prompt!, images: [] });
      }
      let said = false;
      for (const item of turn.items) {
        writer.clock.at = millis(item.startedAtMs) ?? writer.clock.at;
        if (item.type === "userMessage") {
          const message = this.message(item);
          if (message.text || message.images.length > 0) {
            writer.add({ type: "user", ...message, ...(said ? { steered: true } : {}) });
            said = true;
          }
          continue;
        }
        mapper.started(item);
        if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
          await this.subagents(writer, item);
        }
        if (item.status === "inProgress") continue;
        writer.clock.at = millis(item.completedAtMs) ?? writer.clock.at;
        mapper.completed(item);
      }
      last = turnStatus(turn.status);
      writer.endTurn(last, seconds(turn.completedAt) ?? writer.clock.at, {
        error:
          last === "failed" ? (turn.error?.message ?? "Codex stopped with an error.") : undefined,
      });
    }
    return last;
  }

  private async subagents(writer: HistoryWriter, item: CodexItem): Promise<void> {
    const prompt = typeof item.prompt === "string" ? item.prompt : "";
    for (const childId of (item.receiverThreadIds ?? []) as string[]) {
      if (this.read.has(childId)) continue;
      const child = this.history.child(writer, item.id, firstLine(prompt) || "Subagent");
      const entry = this.history.children.find((candidate) => candidate.writer === child);
      try {
        const status = await this.thread(childId, child, prompt);
        if (entry && status === "failed") entry.failed = true;
      } catch {
        // Its thread is gone from Codex: the tool call still shows what it was asked.
        if (prompt) child.add({ type: "user", text: prompt, images: [] });
      }
    }
  }

  private message(item: CodexItem): { text: string; images: ImageRef[] } {
    const parts = (item.content ?? []) as {
      type: string;
      text?: string;
      url?: string;
      path?: string;
    }[];
    const text = parts
      .filter((part) => part.type === "text" && part.text)
      .map((part) => part.text)
      .join("\n");
    const images: ImageRef[] = [];
    for (const part of parts) {
      let image: ImageRef | undefined;
      if (part.type === "localImage" && part.path) image = this.history.keepFile(part.path);
      if (part.type === "image" && part.url) {
        const data = dataUrl(part.url);
        if (data) image = this.history.keepImage(data.data, data.mime);
      }
      if (image) images.push(image);
    }
    return { text, images };
  }
}

function turnStatus(status: string): TurnStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  // Still running when it was read, so cut off here.
  return "interrupted";
}
