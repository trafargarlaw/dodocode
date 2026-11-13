// One thread while the server runs: its items, its turn, its queue, and the provider session that
// does the work. Subagent threads use the same class, written to by their parent's session.

import { resolve as resolvePath } from "node:path";

import {
  TASK_STATUS_LABEL,
  type AppMessage,
  type ApprovalDecision,
  type ApprovalItem,
  type BackgroundJob,
  type ImageRef,
  type Item,
  type OutgoingMessage,
  type ProviderId,
  type Question,
  type QueuedMessage,
  type ServerEvent,
  type SlashCommand,
  type Thread,
  type ThreadSettings,
  type ThreadStatus,
} from "@dodocode/protocol";

import type {
  AgentMove,
  ApprovalRequest,
  FindingAnswerRequest,
  FindingReport,
  IdeaRequest,
  ItemPatch,
  ItemWriter,
  NewItem,
  PageRequest,
  Provider,
  ProviderSession,
  SessionHost,
  SubagentWriter,
  TurnImage,
  TurnMessage,
  TurnOutcome,
} from "./providers/types";
import { endJob, savedJobs, startJob } from "./jobs";
import { relativePath } from "./providers/claude-tools";
import type { ResumePoints, Store } from "./store";
import { moved, started } from "./tasks";
import { errorText, log, newId, titleFrom, within } from "./util";

/** What a thread needs from the rest of the server. */
export interface ThreadContext {
  readonly store: Store;
  /** Sends an event to every client, or only to those with `threadId` open. */
  emit(event: ServerEvent, threadId?: string): void;
  provider(id: ProviderId): Provider;
  /** The folder the thread's agent works in. */
  workDir(thread: Thread): string;
  /** Registers a new subagent thread. */
  adoptThread(thread: Thread): ThreadRuntime;
  /** Remembers the model and effort last used with a provider. */
  settingsUsed(settings: ThreadSettings): void;
  /** Keeps a file a tool gave back, as an attachment. */
  keepFile(data: Buffer, mime: string, name: string): ImageRef | undefined;
  /** Keeps a page the agent showed, and gives the id the server serves it by. */
  keepPage(page: PageRequest, cwd: string): string;
  /** Remembers the slash commands a provider's agent takes in the thread's project. */
  commandsFound(thread: Thread, provider: ProviderId, commands: SlashCommand[]): void;
  /** Puts an idea the agent noticed in `from` in the backlog of its project, as a new task. */
  addIdea(from: Thread, idea: IdeaRequest): Thread;
  /** Keeps what the reviewer in `review` found. Returns what to tell it. */
  reportFindings(review: Thread, findings: FindingReport[]): string;
  /** Records the answers of the agent in `task` to its latest review. Returns what to tell it. */
  answerFindings(task: Thread, answers: FindingAnswerRequest[]): string;
  /** Sets how the project of `from` is reviewed. Returns what to tell the agent. */
  setReviewInstructions(from: Thread, path: string | null): string;
}

/** A message to send, and, when the app wrote it for the person, what it is. */
export type ThreadMessage = OutgoingMessage & { app?: AppMessage };

interface Turn {
  id: string;
  startedAt: number;
  /** Started by the agent rather than by a message. */
  byAgent: boolean;
  items: number;
  interrupting: boolean;
}

type Pending =
  | { kind: "approval"; resolve: (decision: ApprovalDecision) => void }
  | { kind: "question"; resolve: (answers: Record<string, string[]> | null) => void };

const APPEND_FLUSH_MS = 400;
const INTERRUPT_GRACE_MS = 15_000;

export class ThreadRuntime {
  thread: Thread;
  private seq: number;
  private cache = new Map<string, Item>();
  private dirty = new Set<string>();
  private flushTimer: NodeJS.Timeout | undefined;
  private turn: Turn | undefined;
  private queue: QueuedMessage[];
  private jobs: BackgroundJob[];
  private session: ProviderSession | undefined;
  private sessionProvider: ProviderId | undefined;
  private pending = new Map<string, Pending>();
  private resume: ResumePoints;
  /** The subagent threads this thread's session writes into, by tool item. */
  private subagents = new Map<string, ThreadRuntime>();

  private ctx: ThreadContext;

  constructor(ctx: ThreadContext, thread: Thread) {
    this.ctx = ctx;
    this.thread = thread;
    this.seq = ctx.store.lastSeq(thread.id);
    this.queue = ctx.store.queue(thread.id);
    this.jobs = savedJobs(ctx.store.jobs(thread.id));
    this.resume = ctx.store.resumePoints(thread.id);
  }

  get running(): boolean {
    return this.turn !== undefined;
  }

  items(): Item[] {
    this.flush();
    return this.ctx.store.items(this.thread.id);
  }

  queued(): QueuedMessage[] {
    return this.queue;
  }

  backgroundJobs(): BackgroundJob[] {
    return this.jobs;
  }

  // Changes from clients

  async send(message: ThreadMessage, mode: "queue" | "steer" = "queue"): Promise<void> {
    if (this.thread.kind === "subagent") throw new Error("A subagent's thread takes no messages.");
    if (!this.turn) {
      await this.startTurn(message);
      return;
    }
    if (mode === "steer" && (await this.steer(message))) return;
    this.enqueue(message);
  }

  async steerQueued(queueId: string): Promise<void> {
    const queued = this.queue.find((entry) => entry.id === queueId);
    if (!queued) return;
    this.setQueue(this.queue.filter((entry) => entry.id !== queueId));
    const message = { text: queued.text, images: queued.images, app: queued.app };
    if (!this.turn) {
      await this.startTurn(message);
    } else if (!(await this.steer(message))) {
      this.setQueue([queued, ...this.queue]);
      throw new Error("The agent can't take a message right now. It stays queued.");
    }
  }

  removeQueued(queueId: string): void {
    this.setQueue(this.queue.filter((entry) => entry.id !== queueId));
  }

  async interrupt(): Promise<void> {
    const turn = this.turn;
    if (!turn || turn.interrupting) return;
    turn.interrupting = true;
    this.cancelPending();
    const session = this.session;
    if (!session) {
      this.turnEnded({ status: "interrupted" });
      return;
    }
    try {
      await within(session.interrupt(), INTERRUPT_GRACE_MS, undefined);
    } catch (error) {
      log("thread", "interrupt failed", errorText(error));
    }
    // The session ends the turn when the agent stops. If it has not stopped, stop its process.
    setTimeout(() => {
      if (this.turn !== turn) return;
      log("thread", `turn ${turn.id} did not stop; closing its session`);
      void this.disposeSession();
      this.turnEnded({ status: "interrupted" });
    }, INTERRUPT_GRACE_MS).unref();
  }

  async stopJob(jobId: string): Promise<void> {
    await this.session?.stopJob(jobId);
  }

  update(changes: {
    title?: string;
    settings?: Partial<ThreadSettings>;
    pinned?: boolean;
    archived?: boolean;
  }): Thread {
    const settings = { ...this.thread.settings, ...changes.settings };
    this.thread = {
      ...this.thread,
      title: changes.title?.trim() || this.thread.title,
      settings,
      pinned: changes.pinned ?? this.thread.pinned,
      archived: changes.archived ?? this.thread.archived,
      updatedAt: Date.now(),
    };
    this.saveThread();
    if (changes.settings) this.ctx.settingsUsed(settings);
    return this.thread;
  }

  /** Replaces the thread with a changed copy, such as one moved on the board. */
  replace(thread: Thread): Thread {
    this.thread = thread;
    this.saveThread();
    return this.thread;
  }

  /** Adds a note to the thread, between its messages. */
  note(text: string): void {
    this.notice("info", text);
  }

  respondApproval(itemId: string, decision: ApprovalDecision): void {
    const pending = this.pending.get(itemId);
    const item = this.cache.get(itemId) as ApprovalItem | undefined;
    if (!pending || pending.kind !== "approval" || !item) {
      throw new Error("That approval is no longer waiting.");
    }
    this.pending.delete(itemId);
    this.writer.update(itemId, {
      status: decision === "deny" ? "denied" : "allowed",
      decision,
    });
    pending.resolve(decision);
    this.refreshStatus();
  }

  respondQuestion(itemId: string, answers: Record<string, string[]> | null): void {
    const pending = this.pending.get(itemId);
    if (!pending || pending.kind !== "question") {
      throw new Error("Those questions are no longer waiting.");
    }
    this.pending.delete(itemId);
    this.writer.update(itemId, answers ? { status: "answered", answers } : { status: "cancelled" });
    pending.resolve(answers);
    this.refreshStatus();
  }

  async dispose(): Promise<void> {
    this.cancelPending();
    await this.disposeSession();
    this.flush();
  }

  /**
   * Ends the agent's session and forgets it, as when the folder it worked in is gone: the next
   * turn starts a new session, where the thread works then.
   */
  async forgetSession(): Promise<void> {
    await this.disposeSession();
    this.resume = {};
    this.ctx.store.saveResumePoints(this.thread.id, {});
  }

  /** Marks what was left unfinished when the server last stopped. Runs once, at start. */
  recover(): void {
    const unfinished = this.ctx.store
      .items(this.thread.id)
      .filter(
        (item) =>
          ((item.type === "assistant" || item.type === "reasoning") && item.streaming) ||
          (item.type === "tool" && item.status === "running") ||
          ((item.type === "approval" || item.type === "question") && item.status === "pending"),
      );
    for (const item of unfinished) {
      if (item.type === "assistant" || item.type === "reasoning") {
        this.ctx.store.saveItem({ ...item, streaming: false });
      } else if (item.type === "tool") {
        this.ctx.store.saveItem({ ...item, status: "error", background: undefined });
      } else if (item.type === "approval" || item.type === "question") {
        this.ctx.store.saveItem({ ...item, status: "cancelled" });
      }
    }
    const running = this.jobs.filter((job) => job.status === "running");
    if (running.length > 0) {
      this.jobs = this.jobs.map((job) =>
        job.status === "running" ? { ...job, status: "stopped", endedAt: Date.now() } : job,
      );
      this.ctx.store.saveJobs(this.thread.id, this.jobs);
    }
    if (this.thread.status === "running" || this.thread.status === "waiting") {
      this.thread = { ...this.thread, status: "idle" };
      this.ctx.store.saveThread(this.thread);
    }
  }

  // Turns

  private async startTurn(message: ThreadMessage): Promise<void> {
    const turn: Turn = {
      id: newId(),
      startedAt: Date.now(),
      byAgent: false,
      items: 0,
      interrupting: false,
    };
    this.turn = turn;
    if (this.thread.title === "New thread" && message.text.trim()) {
      this.thread = { ...this.thread, title: titleFrom(message.text) };
    }
    this.thread = {
      ...started(this.thread, turn.startedAt),
      activityAt: Date.now(),
      error: undefined,
    };
    this.writer.add({ type: "user", ...userFields(message) });
    this.refreshStatus();
    try {
      const session = this.ensureSession();
      await session.startTurn(this.turnMessage(message));
    } catch (error) {
      log("thread", "turn failed to start", error);
      if (this.turn === turn) this.turnEnded({ status: "failed", error: errorText(error) });
    }
  }

  private async steer(message: ThreadMessage): Promise<boolean> {
    if (!this.session || !this.turn || this.turn.interrupting) return false;
    let sent = false;
    try {
      sent = await this.session.steer(this.turnMessage(message));
    } catch (error) {
      log("thread", "steer failed", errorText(error));
    }
    if (sent) {
      this.writer.add({ type: "user", ...userFields(message), steered: true });
    }
    return sent;
  }

  private enqueue(message: ThreadMessage): void {
    this.setQueue([...this.queue, { id: newId(), ...userFields(message), createdAt: Date.now() }]);
  }

  private setQueue(queue: QueuedMessage[]): void {
    this.queue = queue;
    this.ctx.store.saveQueue(this.thread.id, queue);
    this.ctx.emit({ type: "queue", threadId: this.thread.id, queue }, this.thread.id);
  }

  private turnEnded(outcome: TurnOutcome): void {
    const turn = this.turn;
    if (!turn) return;
    this.cancelPending();
    const status =
      turn.interrupting && outcome.status !== "failed" ? "interrupted" : outcome.status;
    // Close what the agent left open in this turn.
    for (const item of this.cache.values()) {
      if (item.turnId !== turn.id) continue;
      if ((item.type === "assistant" || item.type === "reasoning") && item.streaming) {
        this.writer.update(item.id, { streaming: false });
      } else if (item.type === "tool" && item.status === "running" && !item.background) {
        this.writer.update(item.id, {
          status: status === "completed" ? "done" : "error",
          endedAt: Date.now(),
        });
      }
    }
    if (!(turn.byAgent && turn.items === 0)) {
      this.writer.add({
        type: "turn_end",
        ...outcome,
        status,
        durationMs: Date.now() - turn.startedAt,
      });
    }
    this.turn = undefined;
    // Compacting ends with the turn, however the agent ended it.
    const { compacting: _, ...context } = this.thread.context ?? { used: 0, window: 0, at: 0 };
    this.thread = {
      ...this.thread,
      activityAt: Date.now(),
      error: status === "failed" ? (outcome.error ?? "The turn failed.") : undefined,
      context: this.thread.context ? context : undefined,
    };
    this.flush();
    this.trimCache();
    this.refreshStatus();
    // The next queued message starts the next turn, unless the person stopped this one.
    if (status !== "interrupted") {
      const [next, ...rest] = this.queue;
      if (next) {
        this.setQueue(rest);
        void this.startTurn({ text: next.text, images: next.images, app: next.app });
      }
    }
  }

  private turnMessage(message: OutgoingMessage): TurnMessage {
    const images: TurnImage[] = [];
    for (const image of message.images) {
      const stored = this.ctx.store.attachment(image.id);
      if (stored) images.push(stored);
    }
    return { text: message.text, images };
  }

  // The provider session

  private ensureSession(): ProviderSession {
    const providerId = this.thread.settings.provider;
    if (this.session && this.sessionProvider === providerId) return this.session;
    if (this.session) {
      void this.disposeSession();
      this.notice(
        "info",
        "Switched provider. The new agent starts without the earlier messages in this thread.",
      );
    }
    const provider = this.ctx.provider(providerId);
    this.session = provider.createSession(this.host(providerId));
    this.sessionProvider = providerId;
    return this.session;
  }

  private async disposeSession(): Promise<void> {
    const session = this.session;
    this.session = undefined;
    this.sessionProvider = undefined;
    if (!session) return;
    try {
      await session.dispose();
    } catch (error) {
      log("thread", "session dispose failed", errorText(error));
    }
  }

  private host(providerId: ProviderId): SessionHost {
    // The host's getters need the runtime, and a getter can't be an arrow function.
    // oxlint-disable-next-line typescript/no-this-alias
    const runtime = this;
    return {
      threadId: this.thread.id,
      cwd: this.ctx.workDir(this.thread),
      settings: () => runtime.thread.settings,
      get resumeId() {
        return runtime.resume[providerId]?.id;
      },
      saveResumeId: (id) => {
        if (runtime.resume[providerId]?.id === id) return;
        runtime.resume = { ...runtime.resume, [providerId]: { id } };
        runtime.ctx.store.saveResumePoints(runtime.thread.id, runtime.resume);
      },
      get resumeCost() {
        return runtime.resume[providerId]?.costUsd;
      },
      saveResumeCost: (costUsd) => {
        const point = runtime.resume[providerId];
        if (!point || point.costUsd === costUsd) return;
        runtime.resume = { ...runtime.resume, [providerId]: { ...point, costUsd } };
        runtime.ctx.store.saveResumePoints(runtime.thread.id, runtime.resume);
      },
      items: this.writer,
      agentTurnStarted: () => {
        if (runtime.turn) return;
        runtime.turn = {
          id: newId(),
          startedAt: Date.now(),
          byAgent: true,
          items: 0,
          interrupting: false,
        };
        runtime.refreshStatus();
      },
      turnEnded: (outcome) => runtime.turnEnded(outcome),
      requestApproval: (request, signal) => runtime.requestApproval(request, signal),
      requestAnswers: (questions, signal) => runtime.requestAnswers(questions, signal),
      openSubagent: (options) => runtime.openSubagent(options),
      jobStarted: (job) => runtime.setJobs(startJob(runtime.jobs, job)),
      jobEnded: (id, end) => runtime.setJobs(endJob(runtime.jobs, id, end, Date.now())),
      notice: (level, text) => runtime.notice(level, text),
      moveTask: (status) => runtime.agentMoved(status),
      addIdea: (idea) => {
        const added = runtime.ctx.addIdea(runtime.thread, idea);
        return `Added “${added.title}” to the backlog on the person's board. They decide later whether it's worth doing.`;
      },
      keepImage: (data, mime) => {
        const extension = mime.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        return runtime.ctx.keepFile(Buffer.from(data, "base64"), mime, `image.${extension}`);
      },
      showPage: (page) => {
        const cwd = runtime.ctx.workDir(runtime.thread);
        const viewId = runtime.ctx.keepPage(page, cwd);
        // Shown from the folder the agent works in, when the page is in it.
        const path = page.path && relativePath(resolvePath(cwd, page.path), cwd);
        runtime.writer.add({ type: "view", title: page.title, viewId, path });
        return "The page shows in the conversation now, where the person can open it in a browser too.";
      },
      contextUsed: (patch) => runtime.contextUsed(patch),
      commandsFound: (commands) => runtime.ctx.commandsFound(runtime.thread, providerId, commands),
      reviewing: this.thread.kind === "review",
      reportFindings: (findings) => {
        const first = runtime.thread.review?.reportedAt === undefined;
        const answer = runtime.ctx.reportFindings(runtime.thread, findings);
        // The findings show where the reviewer reported them, and stay current as they're answered.
        if (first) runtime.writer.add({ type: "findings", reviewId: runtime.thread.id });
        return answer;
      },
      answerFindings: (answers) => runtime.ctx.answerFindings(runtime.thread, answers),
      setReviewInstructions: (path) => runtime.ctx.setReviewInstructions(runtime.thread, path),
    };
  }

  private contextUsed(patch: Parameters<SessionHost["contextUsed"]>[0]): void {
    const before = this.thread.context;
    const next = { used: 0, window: 0, ...before, ...patch, at: Date.now() };
    if (next.compacting === false) delete next.compacting;
    if (
      before &&
      before.used === next.used &&
      before.window === next.window &&
      before.autoCompactAt === next.autoCompactAt &&
      before.compacting === next.compacting
    ) {
      return;
    }
    this.thread = { ...this.thread, context: next };
    this.saveThread();
  }

  /** The agent moves its task, as the person asked. The tool call shows in the thread. */
  private agentMoved(status: AgentMove): string {
    const label = TASK_STATUS_LABEL[status];
    if (this.thread.task?.status === status) return `It is in ${label} already.`;
    this.replace(moved(this.thread, status, Date.now()));
    return `Moved it to ${label} on the person's board.`;
  }

  private requestApproval(
    request: ApprovalRequest,
    signal?: AbortSignal,
  ): Promise<ApprovalDecision> {
    const { sessionOption = true, ...fields } = request;
    const item = this.writer.add({
      type: "approval",
      ...fields,
      options: [
        { id: "allow", label: "Allow" },
        ...(sessionOption
          ? [{ id: "allow_session" as const, label: "Allow for this thread" }]
          : []),
        { id: "deny", label: "Deny" },
      ],
      status: "pending",
    });
    return new Promise((resolve) => {
      this.pending.set(item.id, { kind: "approval", resolve });
      this.refreshStatus();
      signal?.addEventListener("abort", () => this.cancel(item.id), { once: true });
    });
  }

  private requestAnswers(
    questions: Question[],
    signal?: AbortSignal,
  ): Promise<Record<string, string[]> | null> {
    const item = this.writer.add({ type: "question", questions, status: "pending" });
    return new Promise((resolve) => {
      this.pending.set(item.id, { kind: "question", resolve });
      this.refreshStatus();
      signal?.addEventListener("abort", () => this.cancel(item.id), { once: true });
    });
  }

  private cancel(itemId: string): void {
    const pending = this.pending.get(itemId);
    if (!pending) return;
    this.pending.delete(itemId);
    this.writer.update(itemId, { status: "cancelled" } as ItemPatch);
    if (pending.kind === "approval") pending.resolve("deny");
    else pending.resolve(null);
    this.refreshStatus();
  }

  private cancelPending(): void {
    for (const itemId of this.pending.keys()) this.cancel(itemId);
  }

  private openSubagent(options: { title: string; toolItemId: string }): SubagentWriter {
    const now = Date.now();
    const child = this.ctx.adoptThread({
      id: newId(),
      projectId: this.thread.projectId,
      parentId: this.thread.id,
      parentItemId: options.toolItemId,
      kind: "subagent",
      title: options.title,
      status: "running",
      settings: this.thread.settings,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
    });
    child.turn = { id: newId(), startedAt: now, byAgent: true, items: 0, interrupting: false };
    this.subagents.set(options.toolItemId, child);
    this.writer.update(options.toolItemId, { childThreadId: child.thread.id });
    const writer = child.writer;
    return {
      threadId: child.thread.id,
      add: (item) => writer.add(item),
      update: (id, patch) => writer.update(id, patch),
      append: (id, field, text) => writer.append(id, field, text),
      get: (id) => writer.get(id),
      finish: (status, summary) => {
        if (!child.turn) return;
        child.turnEnded({
          status:
            status === "completed" ? "completed" : status === "stopped" ? "interrupted" : "failed",
          error: status === "failed" ? (summary ?? "The subagent failed.") : undefined,
        });
      },
    };
  }

  private setJobs(jobs: BackgroundJob[]): void {
    if (jobs === this.jobs) return;
    this.jobs = jobs;
    this.ctx.store.saveJobs(this.thread.id, this.jobs);
    this.ctx.emit({ type: "jobs", threadId: this.thread.id, jobs: this.jobs }, this.thread.id);
  }

  private notice(level: "info" | "warning" | "error", text: string): void {
    this.writer.add({ type: "notice", level, text });
  }

  // Status

  private refreshStatus(): void {
    let status: ThreadStatus;
    if (this.turn) status = this.pending.size > 0 ? "waiting" : "running";
    else status = this.thread.error ? "error" : "idle";
    this.thread = { ...this.thread, status };
    this.saveThread();
  }

  private saveThread(): void {
    this.ctx.store.saveThread(this.thread);
    this.ctx.emit({ type: "thread", thread: this.thread });
  }

  // Items

  readonly writer: ItemWriter = this.makeWriter();

  private makeWriter(): ItemWriter {
    // The writer's getter needs the runtime, and a getter can't be an arrow function.
    // oxlint-disable-next-line typescript/no-this-alias
    const runtime = this;
    return {
      get threadId(): string {
        return runtime.thread.id;
      },
      add: (input: NewItem) => {
        const { id, ...fields } = input;
        const item = {
          ...fields,
          id: id ?? newId(),
          threadId: this.thread.id,
          turnId: this.turn?.id ?? "",
          seq: ++this.seq,
          createdAt: Date.now(),
        } as Item;
        if (this.turn) this.turn.items += 1;
        this.cache.set(item.id, item);
        this.ctx.store.saveItem(item);
        this.ctx.emit({ type: "item", threadId: this.thread.id, item }, this.thread.id);
        return item;
      },
      update: (id: string, patch: ItemPatch) => {
        const current = this.cache.get(id) ?? this.loadItem(id);
        if (!current) return;
        const item = { ...current, ...patch } as Item;
        this.cache.set(id, item);
        this.dirty.delete(id);
        this.ctx.store.saveItem(item);
        this.ctx.emit({ type: "item", threadId: this.thread.id, item }, this.thread.id);
      },
      append: (id: string, field: "text" | "output", text: string) => {
        if (!text) return;
        const current = this.cache.get(id) ?? this.loadItem(id);
        if (!current || !(field in current)) return;
        const before = (current as unknown as Record<string, string>)[field] ?? "";
        const item = { ...current, [field]: before + text } as Item;
        this.cache.set(id, item);
        this.dirty.add(id);
        this.scheduleFlush();
        this.ctx.emit(
          { type: "item.append", threadId: this.thread.id, itemId: id, field, text },
          this.thread.id,
        );
      },
      get: (id: string) => this.cache.get(id) ?? this.loadItem(id),
    };
  }

  private loadItem(id: string): Item | undefined {
    const item = this.ctx.store.items(this.thread.id).find((entry) => entry.id === id);
    if (item) this.cache.set(id, item);
    return item;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), APPEND_FLUSH_MS);
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.dirty.size === 0) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    this.ctx.store.transaction(() => {
      for (const id of ids) {
        const item = this.cache.get(id);
        if (item) this.ctx.store.saveItem(item);
      }
    });
  }

  /** Drops items of finished turns from memory; they stay in the store. */
  trimCache(): void {
    for (const [id, item] of this.cache) {
      if (item.turnId !== this.turn?.id && !this.dirty.has(id) && !this.pending.has(id)) {
        this.cache.delete(id);
      }
    }
  }
}

/** A message's fields as a user item or a queued message keeps them. */
function userFields(message: ThreadMessage): Pick<QueuedMessage, "text" | "images" | "app"> {
  return {
    text: message.text,
    images: message.images,
    ...(message.app ? { app: message.app } : {}),
  };
}
