// The server's state and the methods clients call. Transport lives in main.ts.

import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import { addedPrompt, disputesWaiting, folderNameProblem } from "@dodocode/protocol";
import type {
  ImageRef,
  Item,
  Method,
  OutsideSession,
  Params,
  Project,
  ProviderId,
  ProviderInfo,
  Result,
  ServerEvent,
  SessionListing,
  SessionPlace,
  Settings,
  SlashCommand,
  Thread,
  ThreadOrigin,
  ThreadSettings,
  WorkspaceMode,
  Worktree,
} from "@dodocode/protocol";

import {
  addWorktree,
  branchName,
  branches,
  changesIn,
  cloneRepo,
  commitAll,
  countChanges,
  deleteBranch,
  hasChanges,
  initRepo,
  mainCheckout,
  mergeBranch,
  removeWorktree,
  repoOf,
  restoreWorktree,
  startOf,
} from "./git";
import { expandPath, listFolders } from "./folders";
import { History } from "./history";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import type {
  FindingAnswerRequest,
  FindingReport,
  IdeaRequest,
  PageRequest,
  Provider,
} from "./providers/types";
import {
  answered,
  decided,
  findingsMessage,
  fixAnywayMessage,
  reported,
  reviewPrompt,
  type ReviewBrief,
  undecided,
} from "./review";
import { carriedModel, type Checkout, placeFor, projectHolding } from "./sessions";
import { Store } from "./store";
import { itemFrom, merged, moved, promoted, reopened, split, todoTask } from "./tasks";
import { ThreadRuntime, type ThreadContext, type ThreadMessage } from "./thread";
import { errorText, log, newId } from "./util";
import { fileInFolder, imageType, pageFileType } from "./web-files";

export interface Client {
  send(event: ServerEvent): void;
  /** Threads whose items this client receives. */
  open: Set<string>;
}

type OriginMode = ThreadOrigin["mode"];

type Handler<M extends Method> = (
  params: Params<M>,
  client: Client,
) => Promise<Result<M>> | Result<M>;

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const DEFAULT_SETTINGS: Settings = {
  defaults: { provider: "claude", model: "", effort: "", access: "full" },
  lastByProvider: {},
  workspace: "worktree",
  review: { auto: false },
};

/** The most images of the task's a reviewer is sent with what it is asked. */
const REVIEW_IMAGES = 8;
/** The most of a project's own way to review a reviewer is sent. */
const REVIEW_METHOD_LIMIT = 40_000;

export class App implements ThreadContext {
  readonly store: Store;
  private dataDir: string;
  private attachmentsDir: string;
  /** Where threads without a project work, each in a folder of its own. */
  private scratchDir: string;
  /** Where worktrees go, a folder for each project. */
  private worktreesDir: string;
  /** Watches each project's git folder, to see when it checks out another branch. */
  private gitWatchers = new Map<string, { gitDir: string; watcher: FSWatcher }>();
  /** Worktrees being made, by thread, so two messages at once make one. */
  private preparing = new Map<string, Promise<void>>();
  /** Threads whose worktree is being merged. No turn starts until that's done. */
  private merging = new Set<string>();
  /** Tasks a review is being started for, so two starts at once make one. */
  private startingReview = new Set<string>();
  private providers = new Map<ProviderId, Provider>();
  private providerInfo = new Map<ProviderId, ProviderInfo>();
  /** Each provider's own slash commands. */
  private providerCommands = new Map<ProviderId, SlashCommand[]>();
  /** The slash commands an agent listed in a project, by provider and project. */
  private projectCommands = new Map<string, SlashCommand[]>();
  private projects = new Map<string, Project>();
  private threads = new Map<string, Thread>();
  private runtimes = new Map<string, ThreadRuntime>();
  private settings: Settings;
  private clients = new Set<Client>();
  /** The conversations from other apps the last listing found, by `provider:id`. */
  private found = new Map<string, OutsideSession>();
  /** Conversations being brought in, so two asks at once bring in one thread. */
  private bringing = new Map<string, Promise<Thread>>();
  /** Set when the app stops. It then starts no more work of its own. */
  private stopped = false;
  /** Work the app started on its own, such as reading git, which stopping waits for. */
  private background = new Set<Promise<void>>();

  /** `providers` are the agents it runs. A test gives its own. */
  constructor(
    dataDir: string,
    providers: Provider[] = [new ClaudeProvider(), new CodexProvider()],
  ) {
    this.dataDir = dataDir;
    this.attachmentsDir = join(dataDir, "attachments");
    mkdirSync(this.attachmentsDir, { recursive: true });
    this.scratchDir = join(dataDir, "scratch");
    this.worktreesDir = join(dataDir, "worktrees");
    this.store = new Store(join(dataDir, "dodocode.db"));
    this.settings = { ...DEFAULT_SETTINGS, ...this.store.settings() };
    for (const provider of providers) {
      this.providers.set(provider.id, provider);
      this.providerInfo.set(provider.id, {
        id: provider.id,
        label: provider.label,
        status: "checking",
        models: [],
      });
    }
  }

  start(): void {
    for (const project of this.store.projects()) this.projects.set(project.id, project);
    const recovered: string[] = [];
    for (let thread of this.store.threads()) {
      // Threads from before `startedAt` existed: one with messages has started.
      if (thread.startedAt === undefined && !thread.task && this.store.lastSeq(thread.id) > 0) {
        thread = { ...thread, startedAt: thread.createdAt };
        this.store.saveThread(thread);
      }
      this.threads.set(thread.id, thread);
      const unfinished = thread.status === "running" || thread.status === "waiting";
      if (unfinished || this.store.jobs(thread.id).some((job) => job.status === "running")) {
        this.runtime(thread.id).recover();
        this.threads.set(thread.id, this.runtime(thread.id).thread);
        recovered.push(thread.id);
      }
    }
    // A review the app quit during had no end of turn, so what it reported goes now. Once every
    // thread is in, since its task may come later.
    for (const id of recovered) this.inBackground(() => this.reviewEnded(id, "interrupted"));
    void this.refreshProviders();
    for (const project of this.projects.values()) {
      this.inBackground(() => this.refreshGit(project.id));
    }
    log(
      "app",
      `data in ${this.dataDir}: ${this.projects.size} projects, ${this.threads.size} threads`,
    );
  }

  async dispose(): Promise<void> {
    this.stopped = true;
    for (const { watcher } of this.gitWatchers.values()) watcher.close();
    this.gitWatchers.clear();
    // What that work still finds is saved before the store closes.
    await Promise.allSettled(this.background);
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.store.close();
  }

  /** Runs work the app starts on its own, unless it has stopped. Stopping waits for it. */
  private inBackground(work: () => Promise<void>): void {
    if (this.stopped) return;
    const running = work()
      .catch((error: unknown) => log("app", "work in the background failed", errorText(error)))
      .finally(() => this.background.delete(running));
    this.background.add(running);
  }

  // Clients

  connect(client: Client): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  emit(event: ServerEvent, threadId?: string): void {
    if (event.type === "thread") {
      const before = this.threads.get(event.thread.id);
      this.threads.set(event.thread.id, event.thread);
      this.reachedReview(before, event.thread);
    }
    for (const client of this.clients) {
      if (threadId && !client.open.has(threadId)) continue;
      client.send(event);
    }
    const item = event.type === "item" ? event.item : undefined;
    if (item?.type === "tool" && item.kind === "edit" && item.status === "done") {
      this.filesChanged(item.threadId);
    }
    if (item?.type === "turn_end") {
      this.inBackground(() => this.countWork(item.threadId));
      // After the turn has ended, so what this writes comes after it.
      const status = item.status;
      setImmediate(() => this.inBackground(() => this.reviewEnded(item.threadId, status)));
    }
  }

  /**
   * A chat whose agent, or one of its subagents, changed files becomes a task. A task in review
   * goes back to In progress: its work changed after it was put there.
   */
  private filesChanged(threadId: string): void {
    let root = this.threads.get(threadId);
    while (root?.parentId) {
      // A reviewer only reads; whatever it ran changes nothing about the task.
      if (root.kind === "review") return;
      root = this.threads.get(root.parentId);
    }
    if (!root) return;
    const runtime = this.runtime(root.id);
    const now = Date.now();
    const back = reopened(runtime.thread, now);
    if (back) {
      runtime.replace(back);
      runtime.note("Changed files while in review, so it's back in In progress.");
      return;
    }
    const next = promoted(runtime.thread, now);
    if (!next) return;
    runtime.replace(next);
    runtime.note("Changed files, so this chat became a task.");
  }

  /**
   * Runs a method. A method that finishes at once returns its result rather than a promise, so
   * the caller can answer before any other event goes out: a client then knows that a result
   * holds every event it got before the answer, and none it gets after.
   */
  call<M extends Method>(
    method: M,
    params: Params<M>,
    client: Client,
  ): Promise<Result<M>> | Result<M> {
    const handler = this.handlers[method] as Handler<M> | undefined;
    if (!handler) throw new Error(`Unknown method ${method}.`);
    return handler(params ?? ({} as Params<M>), client);
  }

  // ThreadContext

  provider(id: ProviderId): Provider {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider ${id}.`);
    return provider;
  }

  workDir(thread: Thread): string {
    // A subagent works where the thread that started it works.
    const root = this.rootOf(thread);
    if (root.worktree && root.worktree.mergedAt === undefined) return root.worktree.workDir;
    // A conversation from another app carries on where it worked there.
    if (root.origin) return root.origin.cwd;
    if (root.projectId) return this.projectPath(root.projectId);
    const dir = join(this.scratchDir, root.id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  adoptThread(thread: Thread): ThreadRuntime {
    this.store.saveThread(thread);
    this.threads.set(thread.id, thread);
    const runtime = new ThreadRuntime(this, thread);
    this.runtimes.set(thread.id, runtime);
    this.emit({ type: "thread", thread });
    return runtime;
  }

  settingsUsed(settings: ThreadSettings): void {
    this.settings = {
      ...this.settings,
      defaults: settings,
      lastByProvider: {
        ...this.settings.lastByProvider,
        [settings.provider]: { model: settings.model, effort: settings.effort },
      },
    };
    this.store.saveSettings(this.settings);
    this.emit({ type: "settings", settings: this.settings });
  }

  keepFile(data: Buffer, mime: string, name: string): ImageRef | undefined {
    const extension = IMAGE_EXTENSIONS[mime];
    if (!extension) return undefined;
    const id = newId();
    const path = join(this.attachmentsDir, `${id}${extension}`);
    writeFileSync(path, data);
    const ref = { id, name: name || `image${extension}`, mime };
    this.store.saveAttachment({ ...ref, path });
    return ref;
  }

  keepPage(page: PageRequest, cwd: string): string {
    const id = newId();
    let path: string;
    if (page.path) {
      path = resolve(cwd, page.path);
      if (!/\.html?$/i.test(path)) throw new Error(`${path} is not an .html file.`);
      if (!existsSync(path) || !statSync(path).isFile()) {
        throw new Error(`There is no file at ${path}.`);
      }
    } else if (page.html?.trim()) {
      // A folder of its own, so the page can load nothing beside it.
      const folder = join(this.attachmentsDir, "pages", id);
      mkdirSync(folder, { recursive: true });
      path = join(folder, "index.html");
      writeFileSync(path, page.html);
    } else {
      throw new Error("Give the page's html, or the path of an .html file.");
    }
    this.store.saveAttachment({ id, name: page.title, mime: "text/html", path });
    return id;
  }

  commandsFound(thread: Thread, provider: ProviderId, commands: SlashCommand[]): void {
    this.projectCommands.set(`${provider}:${thread.projectId ?? ""}`, commands);
  }

  addIdea(from: Thread, idea: IdeaRequest): Thread {
    // A subagent's idea belongs to the task it works for.
    const root = this.rootOf(from);
    if (!root.projectId) {
      throw new Error("This conversation has no project, so there is no board to add it to.");
    }
    const details = idea.details?.trim();
    const text = details ? `${idea.title.trim()}\n\n${details}` : idea.title;
    const thread = todoTask(
      this.newThread(root.projectId, this.threadSettings(undefined)),
      itemFrom({ text, images: [] }),
      Date.now(),
      "backlog",
    );
    return this.adoptThread({ ...thread, task: { ...thread.task!, suggestedBy: root.id } }).thread;
  }

  reportFindings(from: Thread, findings: FindingReport[]): string {
    const runtime = this.runtime(from.id);
    const review = runtime.thread.review;
    if (!review) throw new Error("Only a review reports findings.");
    runtime.replace({ ...runtime.thread, review: reported(review, findings, Date.now()) });
    const kept =
      findings.length === 0
        ? "Noted that you found nothing."
        : `Kept ${findings.length} ${findings.length === 1 ? "finding" : "findings"}.`;
    return `${kept} When your turn ends, they go to the agent that did the work, which answers each one. Now reply with your report for the person.`;
  }

  answerFindings(from: Thread, answers: FindingAnswerRequest[]): string {
    const task = this.rootOf(from);
    const sent = this.reviewsOf(task.id).flatMap((thread) =>
      thread.review?.sentAt !== undefined ? [{ id: thread.id, review: thread.review }] : [],
    );
    if (sent.length === 0) {
      throw new Error("No review's findings were sent to you, so there is nothing to answer.");
    }
    // An answer can be for any review sent, not only the latest: the agent may answer one late.
    const reviews = answered(
      sent.map((entry) => entry.review),
      answers,
    );
    sent.forEach((entry, index) => {
      const review = reviews[index]!;
      if (review === entry.review) return;
      const runtime = this.runtime(entry.id);
      runtime.replace({ ...runtime.thread, review });
    });
    const findings = reviews.flatMap((review) => review.findings);
    const open = findings.filter((finding) => !finding.answer).map((finding) => finding.id);
    return [
      "Recorded your answers, which the person sees with the findings.",
      open.length > 0 ? `Still to answer: ${open.join(", ")}.` : "",
      reviews.some((review) => disputesWaiting(review).length > 0)
        ? "The person decides on what you disputed. If they want one fixed anyway, you'll hear."
        : "",
    ]
      .filter(Boolean)
      .join(" ");
  }

  setReviewInstructions(from: Thread, path: string | null): string {
    const root = this.rootOf(from);
    if (!root.projectId) throw new Error("This conversation has no project to set it for.");
    const project = this.setProjectReview(root.projectId, path, [this.workDir(root)]);
    return path
      ? `Reviews of ${project.name} follow ${path} from now on. The app still gives the reviewer the changes and the spec, and has it report findings.`
      : `Reviews of ${project.name} follow the built-in way again.`;
  }

  // Reviews

  /** The reviews of a task, oldest first. */
  private reviewsOf(taskId: string): Thread[] {
    return [...this.threads.values()]
      .filter((thread) => thread.kind === "review" && thread.parentId === taskId)
      .toSorted((a, b) => a.createdAt - b.createdAt);
  }

  /** A task that reached In review gets reviewed, the first time, when the person wants that. */
  private reachedReview(before: Thread | undefined, after: Thread): void {
    if (after.kind !== "main" || after.task?.status !== "review") return;
    if (!before || before.task?.status === "review") return;
    if (!this.settings.review.auto || after.task.autoReviewed) return;
    setImmediate(() => this.inBackground(() => this.autoReview(after.id)));
  }

  private async autoReview(taskId: string): Promise<void> {
    const runtime = this.runtimes.get(taskId);
    const task = runtime?.thread.task;
    if (!runtime || task?.status !== "review" || task.autoReviewed) return;
    try {
      await this.startReview(taskId, true);
    } catch (error) {
      runtime.note(`It wasn't reviewed: ${errorText(error)}`);
      return;
    }
    const current = runtime.thread.task;
    if (current) runtime.replace({ ...runtime.thread, task: { ...current, autoReviewed: true } });
  }

  /**
   * Starts a fresh agent reviewing a task's work, in a thread under the task. While one runs,
   * gives back that one.
   */
  private async startReview(taskId: string, auto: boolean): Promise<Thread> {
    const task = this.runtime(taskId).thread;
    if (task.kind !== "main" || !task.task || !task.projectId) {
      throw new Error("Only a task's work can be reviewed.");
    }
    if (task.startedAt === undefined) throw new Error("It hasn't started, so there's no work yet.");
    if (task.worktree?.mergedAt !== undefined) throw new Error("Its work is merged already.");
    const running = this.reviewsOf(taskId).find((review) => this.runtimes.get(review.id)?.running);
    if (running) return running;
    if (this.startingReview.has(taskId)) throw new Error("A review of it is starting already.");
    this.startingReview.add(taskId);
    try {
      await this.prepareWorkspace(taskId);
      const project = this.project(task.projectId);
      const where = await this.reviewBase(task, project);
      const count = await countChanges(where.folder, where.base);
      if (count.files === 0) {
        throw new Error("It has changed nothing yet, so there's nothing to review.");
      }
      const method = this.reviewMethod(project, where.folder);
      const items = this.runtime(taskId).items();
      const brief: ReviewBrief = {
        title: task.title,
        base: where.base,
        baseLabel: where.label,
        ...(task.worktree ? { branch: task.worktree.branch } : {}),
        covers: task.task.covers,
        messages: personsMessages(items),
        ...(method.found ? { method: method.found } : {}),
      };
      const now = Date.now();
      const reviewer = this.settings.review.model ?? task.settings;
      const runtime = this.adoptThread({
        id: newId(),
        projectId: task.projectId,
        parentId: task.id,
        kind: "review",
        title: `Review: ${task.title}`,
        status: "idle",
        settings: {
          provider: reviewer.provider,
          model: reviewer.model,
          effort: reviewer.effort,
          access: "full",
        },
        createdAt: now,
        updatedAt: now,
        activityAt: now,
        review: {
          base: where.base,
          baseLabel: where.label,
          ...(method.found ? { instructions: method.found.path } : {}),
          ...(auto ? { auto } : {}),
          findings: [],
        },
      });
      if (method.missing) {
        runtime.note(
          `${method.missing} isn't there, so it reviews the built-in way. Set another file in the board's review settings.`,
        );
      }
      await runtime.send({
        text: reviewPrompt(brief),
        images: taskImages(task, items),
        app: { kind: "review" },
      });
      return runtime.thread;
    } finally {
      this.startingReview.delete(taskId);
    }
  }

  /** What a task's work is compared with: where its branch left the base, or its last commit. */
  private async reviewBase(
    task: Thread,
    project: Project,
  ): Promise<{ folder: string; base: string; label: string }> {
    const worktree = task.worktree;
    if (worktree) {
      const base = await startOf(worktree.path, worktree.base ?? worktree.from);
      return { folder: worktree.path, base, label: worktree.base ?? `commit ${base.slice(0, 7)}` };
    }
    const repo = await repoOf(project.path);
    if (!repo) throw new Error(`${project.name} isn't in git, so there's no telling what changed.`);
    const base = await startOf(project.path, undefined);
    const label = repo.head
      ? `the last commit${repo.branch ? ` on ${repo.branch}` : ""}`
      : "an empty repository";
    return { folder: project.path, base, label };
  }

  /**
   * The project's own way to review, read from its file. Unset, or when the file isn't there,
   * the built-in way; `missing` then says which file wasn't.
   */
  private reviewMethod(
    project: Project,
    folder: string,
  ): { found?: { path: string; text: string }; missing?: string } {
    const path = project.reviewInstructions;
    if (!path) return {};
    const file = instructionsFile(path, [folder, project.path]);
    if (!file) return { missing: path };
    return { found: { path, text: readFileSync(file, "utf8").slice(0, REVIEW_METHOD_LIMIT) } };
  }

  /** Sets how a project's work is reviewed: a Markdown file, which must be there, or `null`. */
  private setProjectReview(projectId: string, path: string | null, folders: string[]): Project {
    const project = this.project(projectId);
    const { reviewInstructions: _old, ...rest } = project;
    let next: Project = rest;
    const wanted = path?.trim();
    if (wanted) {
      if (!instructionsFile(wanted, [...folders, project.path])) {
        throw new Error(`There's no file at ${wanted}, in ${project.name} or as an absolute path.`);
      }
      next = { ...rest, reviewInstructions: wanted };
    }
    this.projects.set(projectId, next);
    this.store.saveProject(next);
    this.emitProjects();
    return next;
  }

  /**
   * After a review's turn: its findings go to the task's agent, once. A review that ended
   * without reporting says so.
   */
  private async reviewEnded(threadId: string, status: string): Promise<void> {
    const runtime = this.runtimes.get(threadId);
    const thread = runtime?.thread;
    const review = thread?.review;
    if (!runtime || !thread?.parentId || !review || review.sentAt !== undefined) return;
    if (review.reportedAt === undefined) {
      if (status === "completed") {
        runtime.note(
          "It ended without reporting findings, so nothing went to the task. Ask it to report them.",
        );
      }
      return;
    }
    if (!this.threads.has(thread.parentId)) return;
    const task = this.runtime(thread.parentId);
    runtime.replace({ ...thread, review: { ...review, sentAt: Date.now() } });
    if (review.findings.length === 0) {
      task.note("A review found nothing to change.");
      return;
    }
    if (task.thread.task?.status === "done") {
      task.note(
        "A review found things to change, but the task is done, so they stay in the review.",
      );
      return;
    }
    await this.sendToTask(task.thread.id, {
      text: findingsMessage(review),
      images: [],
      app: { kind: "findings", reviewId: thread.id },
    }).catch((error: unknown) => {
      // Marked sent before sending, so a second end of turn doesn't send them twice. Unsent, they
      // go again at the next one.
      const current = runtime.thread.review;
      if (current) {
        const { sentAt: _, ...unsent } = current;
        runtime.replace({ ...runtime.thread, review: unsent });
      }
      runtime.note(
        `The findings couldn't go to the task, so they wait here. Send the reviewer a message, and they go when its turn ends. What went wrong: ${errorText(error)}`,
      );
    });
  }

  /** Sends the task's agent a message the app wrote, once its folder is ready. */
  private async sendToTask(taskId: string, message: ThreadMessage): Promise<void> {
    if (this.merging.has(taskId)) throw new Error("Its work is being merged.");
    await this.prepareWorkspace(taskId);
    await this.runtime(taskId).send(message);
  }

  // Helpers

  private project(projectId: string): Project {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("The project is gone.");
    return project;
  }

  private projectPath(projectId: string): string {
    return this.project(projectId).path;
  }

  /** The main thread a thread belongs to: itself, or the one that started its subagent. */
  private rootOf(thread: Thread): Thread {
    let root = thread;
    while (root.parentId) {
      const parent = this.threads.get(root.parentId);
      if (!parent) break;
      root = parent;
    }
    return root;
  }

  /** Where tasks start, remembered from the choice made last. */
  private workspaceUsed(workspace: WorkspaceMode): void {
    if (this.settings.workspace === workspace) return;
    this.settings = { ...this.settings, workspace };
    this.store.saveSettings(this.settings);
    this.emit({ type: "settings", settings: this.settings });
  }

  // Git

  /** Reads what a project's folder has checked out, and watches it for a change. */
  private async refreshGit(projectId: string): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) return;
    let repo: Awaited<ReturnType<typeof repoOf>>;
    try {
      repo = await repoOf(project.path);
    } catch (error) {
      log("app", `could not read git in ${project.path}`, errorText(error));
      return;
    }
    const current = this.projects.get(projectId);
    if (!current) return;
    // A watcher made once the app stopped would be left behind.
    if (!this.stopped) this.watchGit(projectId, repo?.gitDir);
    const git = repo ? (repo.branch ? { branch: repo.branch } : {}) : undefined;
    if (JSON.stringify(git) === JSON.stringify(current.git)) return;
    const { git: _old, ...rest } = current;
    const next: Project = git ? { ...rest, git } : rest;
    this.projects.set(projectId, next);
    this.store.saveProject(next);
    this.emitProjects();
  }

  private watchGit(projectId: string, gitDir: string | undefined): void {
    const watching = this.gitWatchers.get(projectId);
    if (watching?.gitDir === gitDir) return;
    watching?.watcher.close();
    this.gitWatchers.delete(projectId);
    if (!gitDir) return;
    let timer: NodeJS.Timeout | undefined;
    try {
      // Checking out a branch rewrites HEAD. Other files there change all the time.
      const watcher = watch(gitDir, (_event, file) => {
        if (file !== "HEAD") return;
        clearTimeout(timer);
        timer = setTimeout(() => this.inBackground(() => this.refreshGit(projectId)), 150);
      });
      watcher.on("error", () => {
        watcher.close();
        if (this.gitWatchers.get(projectId)?.watcher === watcher)
          this.gitWatchers.delete(projectId);
      });
      watcher.unref();
      this.gitWatchers.set(projectId, { gitDir, watcher });
    } catch (error) {
      log("app", `could not watch ${gitDir}`, errorText(error));
    }
  }

  private unwatchGit(projectId: string): void {
    this.gitWatchers.get(projectId)?.watcher.close();
    this.gitWatchers.delete(projectId);
  }

  /**
   * Gets a thread's folder ready before a turn: makes its worktree before its first turn, when
   * it works in one, and makes it again when its folder went missing.
   */
  private prepareWorkspace(threadId: string): Promise<void> {
    const pending = this.preparing.get(threadId);
    if (pending) return pending;
    const work = this.makeWorkspace(threadId).finally(() => this.preparing.delete(threadId));
    this.preparing.set(threadId, work);
    return work;
  }

  private async makeWorkspace(threadId: string): Promise<void> {
    const runtime = this.runtime(threadId);
    const thread = runtime.thread;
    const origin = this.rootOf(thread).origin;
    if (origin && !existsSync(origin.cwd)) {
      throw new Error(
        `The folder this conversation worked in, ${origin.cwd}, is gone, so it can't carry on.`,
      );
    }
    if (thread.kind !== "main" || !thread.projectId || runtime.running) return;
    const project = this.project(thread.projectId);
    const worktree = thread.worktree;
    if (worktree) {
      if (worktree.mergedAt !== undefined || existsSync(worktree.path)) return;
      try {
        await restoreWorktree(project.path, worktree.path, worktree.branch);
      } catch (error) {
        throw new Error(
          `Its worktree is gone, and could not be made again from ${worktree.branch}: ${errorText(error)}`,
          { cause: error },
        );
      }
      runtime.note(`Its worktree was gone, so it was made again from ${worktree.branch}.`);
      return;
    }
    if (thread.startedAt !== undefined) return;
    const mode = thread.workspace ?? (thread.task ? this.settings.workspace : "local");
    if (mode !== "worktree") return;
    const repo = await repoOf(project.path);
    // A folder git doesn't know has no branch to work apart from: the agent works in it.
    if (!repo) {
      runtime.replace({ ...runtime.thread, workspace: "local" });
      return;
    }
    if (!repo.head) {
      throw new Error(
        `${project.name} has no commits yet, so a worktree has nothing to start from. Commit something first, or work in the project's folder.`,
      );
    }
    const parent = join(this.worktreesDir, `${basename(project.path)}-${project.id.slice(0, 8)}`);
    const taken = await branches(project.path);
    const branch = branchName(
      thread.title,
      (name) => taken.has(name) || existsSync(join(parent, name)),
    );
    const path = join(parent, branch);
    mkdirSync(parent, { recursive: true });
    await addWorktree(project.path, path, branch);
    const made: Worktree = {
      path,
      workDir: repo.prefix ? join(path, repo.prefix) : path,
      branch,
      ...(repo.branch ? { base: repo.branch } : {}),
      from: repo.head,
    };
    runtime.replace({ ...runtime.thread, workspace: "worktree", worktree: made });
    const left = (await hasChanges(project.path).catch(() => false))
      ? ` What isn't committed in ${project.name} is not in it.`
      : "";
    const from = repo.branch ?? `commit ${repo.head.slice(0, 7)}`;
    runtime.note(
      `Works in a worktree of its own, on the new branch ${branch} from ${from}.${left}`,
    );
  }

  /** Counts what a thread's work changed in its worktree, after a turn. */
  private async countWork(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    const root = this.rootOf(thread);
    const worktree = root.worktree;
    if (!worktree || worktree.mergedAt !== undefined || !existsSync(worktree.path)) return;
    let changed;
    try {
      changed = await countChanges(worktree.path, worktree.base);
    } catch (error) {
      log("app", "could not count a worktree's changes", errorText(error));
      return;
    }
    const runtime = this.runtimes.get(root.id);
    const current = runtime?.thread.worktree;
    if (!runtime || current?.path !== worktree.path || current.mergedAt !== undefined) return;
    if (JSON.stringify(current.changed) === JSON.stringify(changed)) return;
    runtime.replace({ ...runtime.thread, worktree: { ...current, changed } });
  }

  /**
   * Removes a worktree whose thread went. What the agent left in it is committed to its branch
   * first, and the branch stays. When that commit fails, the worktree stays too.
   */
  private async dropWorktree(
    projectPath: string,
    worktree: Worktree,
    title: string,
    stopped: Promise<unknown>,
  ): Promise<void> {
    await stopped;
    if (!existsSync(worktree.path)) return;
    try {
      await commitAll(worktree.path, `WIP: ${title}`);
    } catch (error) {
      log("app", `kept ${worktree.path}: its changes could not be committed`, errorText(error));
      return;
    }
    try {
      await removeWorktree(projectPath, worktree.path);
    } catch (error) {
      log("app", `could not remove ${worktree.path}`, errorText(error));
    }
  }

  /** A main thread, not started, with its settings filled in. */
  private newThread(projectId: string | undefined, settings: ThreadSettings): Thread {
    const now = Date.now();
    return {
      id: newId(),
      ...(projectId ? { projectId } : {}),
      kind: "main",
      title: "New thread",
      status: "idle",
      settings,
      createdAt: now,
      updatedAt: now,
      activityAt: now,
    };
  }

  private runtime(threadId: string): ThreadRuntime {
    let runtime = this.runtimes.get(threadId);
    if (!runtime) {
      const thread = this.threads.get(threadId);
      if (!thread) throw new Error("The thread is gone.");
      runtime = new ThreadRuntime(this, thread);
      this.runtimes.set(threadId, runtime);
    }
    return runtime;
  }

  private emitProjects(): void {
    this.emit({ type: "projects", projects: [...this.projects.values()] });
  }

  private async refreshProviders(): Promise<ProviderInfo[]> {
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        let info: ProviderInfo;
        try {
          const { commands, ...checked } = await provider.check();
          info = checked;
          this.providerCommands.set(provider.id, commands ?? []);
        } catch (error) {
          info = {
            id: provider.id,
            label: provider.label,
            status: "error",
            message: errorText(error),
            models: [],
          };
        }
        this.providerInfo.set(provider.id, info);
        log(
          "app",
          `${provider.label}: ${info.status}${info.message ? ` (${info.message})` : ""}, ${info.models.length} models`,
        );
        this.emit({ type: "providers", providers: [...this.providerInfo.values()] });
      }),
    );
    this.fillDefaults();
    return [...this.providerInfo.values()];
  }

  /** Picks a model for the defaults once the providers have listed theirs. */
  private fillDefaults(): void {
    const defaults = this.settings.defaults;
    const models = this.providerInfo.get(defaults.provider)?.models ?? [];
    if (models.length === 0 || models.some((model) => model.id === defaults.model)) return;
    const model = models[0]!;
    this.settings = {
      ...this.settings,
      defaults: { ...defaults, model: model.id, effort: model.defaultEffort ?? "" },
    };
    this.store.saveSettings(this.settings);
    this.emit({ type: "settings", settings: this.settings });
  }

  /** Fills in what the client left out of a new thread's settings. */
  private threadSettings(partial: Partial<ThreadSettings> | undefined): ThreadSettings {
    const defaults = this.settings.defaults;
    const provider = partial?.provider ?? defaults.provider;
    const last = provider === defaults.provider ? defaults : this.settings.lastByProvider[provider];
    const models = this.providerInfo.get(provider)?.models ?? [];
    const model = partial?.model ?? last?.model ?? models[0]?.id ?? "";
    const effort =
      partial?.effort ??
      last?.effort ??
      models.find((entry) => entry.id === model)?.defaultEffort ??
      "";
    return { provider, model, effort, access: partial?.access ?? defaults.access };
  }

  private deleteThreadTree(threadId: string): void {
    // The thread, its subagents' threads, and theirs.
    const ids = [threadId];
    for (let index = 0; index < ids.length; index += 1) {
      for (const thread of this.threads.values()) {
        if (thread.parentId === ids[index]) ids.push(thread.id);
      }
    }
    const root = this.threads.get(threadId);
    const scratch = root?.projectId ? undefined : threadId;
    const worktree =
      root?.worktree && root.worktree.mergedAt === undefined ? root.worktree : undefined;
    const projectPath = root?.projectId ? this.projects.get(root.projectId)?.path : undefined;
    const stopped: Promise<void>[] = [];
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime) stopped.push(runtime.dispose());
      this.runtimes.delete(id);
      this.threads.delete(id);
      this.emit({ type: "thread.removed", threadId: id });
    }
    this.store.deleteThread(threadId);
    if (root && worktree && projectPath) {
      void this.dropWorktree(projectPath, worktree, root.title, Promise.allSettled(stopped));
    }
    // The folder made for a thread without a project goes with it.
    if (scratch) {
      try {
        rmSync(join(this.scratchDir, scratch), { recursive: true, force: true });
      } catch (error) {
        log("app", "could not delete the folder of a thread", errorText(error));
      }
    }
  }

  /** Adds a folder as a project, or gives back the project it already is. */
  private async addProject(full: string): Promise<Project> {
    let isFolder = false;
    try {
      isFolder = statSync(full).isDirectory();
    } catch {
      // Missing, which the check below reports.
    }
    if (!isFolder) throw new Error(`${full} is not a folder.`);
    const key = process.platform === "win32" ? full.toLowerCase() : full;
    const existing = [...this.projects.values()].find(
      (project) =>
        (process.platform === "win32" ? project.path.toLowerCase() : project.path) === key,
    );
    if (existing) return existing;
    const project: Project = {
      id: newId(),
      name: basename(full) || full,
      path: full,
      createdAt: Date.now(),
    };
    this.projects.set(project.id, project);
    this.store.saveProject(project);
    await this.refreshGit(project.id);
    this.emitProjects();
    return this.project(project.id);
  }

  /** Where a new project's folder goes: `name` in `parent`, which must be free. */
  private newFolder(parent: string, name: string): string {
    const problem = folderNameProblem(name);
    if (problem) throw new Error(problem);
    const where = expandPath(parent);
    let isFolder = false;
    try {
      isFolder = statSync(where).isDirectory();
    } catch {
      // Missing, which the check below reports.
    }
    if (!isFolder) throw new Error(`There is no folder at ${where}.`);
    const target = join(where, name.trim());
    if (existsSync(target)) throw new Error(`There's already a ${name.trim()} in ${where}.`);
    return target;
  }

  private openInEditor(path: string): void {
    const options = { detached: true, stdio: "ignore" as const, windowsHide: true };
    const child =
      process.platform === "win32"
        ? spawn(`code "${path}"`, [], { ...options, shell: true })
        : process.platform === "darwin"
          ? spawn("open", ["-a", "Visual Studio Code", path], options)
          : spawn("code", [path], options);
    child.on("error", (error) => log("app", "could not open VS Code", errorText(error)));
    child.unref();
  }

  // Conversations from other apps

  /** Every provider's conversations in other apps, newest first, beside dodocode's threads. */
  private async listSessions(): Promise<SessionListing> {
    const brought = new Map<string, string>();
    for (const thread of this.threads.values()) {
      if (thread.origin) {
        brought.set(`${thread.origin.provider}:${thread.origin.sessionId}`, thread.id);
      }
    }
    const ours = this.store.ownSessions();
    const listing: SessionListing = { sessions: [], problems: [] };
    await Promise.all(
      [...this.providers.values()].map(async (provider) => {
        if (this.providerInfo.get(provider.id)?.status === "missing") return;
        try {
          for (const session of await provider.sessions.list()) {
            const key = `${provider.id}:${session.id}`;
            const threadId = brought.get(key);
            // dodocode's own threads, and the copies it carries on, show as threads already.
            if (!threadId && ours.has(key)) continue;
            listing.sessions.push({
              provider: provider.id,
              ...session,
              ...(threadId ? { threadId } : {}),
            });
          }
        } catch (error) {
          log("app", `could not list ${provider.label}'s conversations`, errorText(error));
          listing.problems.push({ provider: provider.id, message: errorText(error) });
        }
      }),
    );
    listing.sessions.sort((a, b) => b.updatedAt - a.updatedAt);
    this.found = new Map(
      listing.sessions.map((session) => [`${session.provider}:${session.id}`, session]),
    );
    return listing;
  }

  private async foundSession(provider: ProviderId, sessionId: string): Promise<OutsideSession> {
    const key = `${provider}:${sessionId}`;
    if (!this.found.has(key)) await this.listSessions();
    const session = this.found.get(key);
    if (!session) throw new Error("That conversation is gone.");
    return session;
  }

  /** The project a conversation from another app goes in, by the folder it worked in. */
  private async placeOf(cwd: string): Promise<SessionPlace> {
    const projects = [...this.projects.values()];
    if (!existsSync(cwd)) {
      const holding = projectHolding(projects, cwd);
      return { ...(holding ? known(holding) : {}), folderGone: true };
    }
    const placing = placeFor(projects, cwd, await checkoutOf(cwd));
    if (!placing) return {};
    if ("project" in placing) return known(placing.project);
    return { project: { name: basename(placing.add) || placing.add, path: placing.add } };
  }

  private bringIn(provider: ProviderId, sessionId: string, mode: OriginMode): Promise<Thread> {
    const key = `${provider}:${sessionId}`;
    const pending = this.bringing.get(key);
    if (pending) return pending;
    const work = this.readIn(provider, sessionId, mode).finally(() => this.bringing.delete(key));
    this.bringing.set(key, work);
    return work;
  }

  /**
   * Makes a thread of a conversation from another app: all that was said and done in it, and
   * in its subagents, then the agent's own session to carry on, itself or a copy.
   */
  private async readIn(
    providerId: ProviderId,
    sessionId: string,
    mode: OriginMode,
  ): Promise<Thread> {
    const already = [...this.threads.values()].find(
      (thread) => thread.origin?.provider === providerId && thread.origin.sessionId === sessionId,
    );
    if (already) return already;
    const provider = this.provider(providerId);
    const session = await this.foundSession(providerId, sessionId);
    const threadId = newId();
    const history = new History(threadId, (data, mime, name) => this.keepFile(data, mime, name));
    const read = await provider.sessions.read(sessionId, history);
    const place = await this.placeOf(session.cwd);
    // Where what happened there ends, and what happens here begins.
    const now = Date.now();
    history.main.clock.at = now;
    history.main.add({
      type: "notice",
      level: "info",
      text: broughtNotice(session.app, mode, place),
    });
    const items = history.main.finish();
    if (items.length === 1) throw new Error("That conversation has nothing in it yet.");
    const project = place.project?.id
      ? this.project(place.project.id)
      : place.project && !place.folderGone
        ? await this.addProject(place.project.path)
        : undefined;
    const carried = carriedModel(
      this.providerInfo.get(providerId)?.models ?? [],
      read.model,
      read.effort,
    );
    const settings = this.threadSettings({ provider: providerId, ...carried });
    const { first } = span(items, session.createdAt ?? session.updatedAt);
    const thread: Thread = {
      id: threadId,
      ...(project ? { projectId: project.id } : {}),
      kind: "main",
      title: read.title || session.title,
      status: "idle",
      settings,
      createdAt: first,
      updatedAt: now,
      // Bringing it in is what happened in it last.
      activityAt: now,
      startedAt: first,
      origin: {
        provider: providerId,
        app: session.app,
        sessionId,
        cwd: session.cwd,
        mode,
        broughtAt: now,
      },
    };
    const children = history.children.map((child) => {
      const childItems = child.writer.finish();
      const times = span(childItems, first);
      const childThread: Thread = {
        id: child.writer.threadId,
        ...(project ? { projectId: project.id } : {}),
        parentId: child.parentId,
        parentItemId: child.parentItemId,
        kind: "subagent",
        title: child.title,
        status: "idle",
        settings,
        createdAt: times.first,
        updatedAt: now,
        activityAt: times.last,
        startedAt: times.first,
      };
      return { thread: childThread, items: childItems };
    });
    // The copy comes last, once all else is ready: it is made in the other app, and nothing here
    // takes it away again. One whose folder is gone can't carry on, so it needs no copy.
    const resumeId =
      mode === "same"
        ? sessionId
        : place.folderGone
          ? undefined
          : await provider.sessions.copy(sessionId, session.cwd);
    // Kept apart from the thread, so a copy left by a save that failed isn't offered either.
    if (resumeId && mode === "copy") this.store.saveOwnSession(providerId, resumeId);
    this.store.transaction(() => {
      this.store.saveThread(thread);
      if (resumeId) {
        this.store.saveResumePoints(thread.id, {
          [providerId]: {
            id: resumeId,
            ...(read.costUsd !== undefined ? { costUsd: read.costUsd } : {}),
          },
        });
      }
      for (const item of items) this.store.saveItem(item);
      for (const child of children) {
        this.store.saveThread(child.thread);
        for (const item of child.items) this.store.saveItem(item);
      }
    });
    this.emit({ type: "thread", thread });
    for (const child of children) this.emit({ type: "thread", thread: child.thread });
    log(
      "app",
      `brought in ${provider.label} conversation ${sessionId} from ${session.app} (${mode}): ${items.length} items, ${children.length} subagents`,
    );
    return thread;
  }

  // Methods

  private handlers: { [M in Method]: Handler<M> } = {
    "app.snapshot": () => ({
      projects: [...this.projects.values()],
      threads: [...this.threads.values()],
      providers: [...this.providerInfo.values()],
      settings: this.settings,
    }),

    "project.add": ({ path }) => this.addProject(expandPath(path)),

    "project.create": async ({ parent, name }) => {
      const target = this.newFolder(parent, name);
      mkdirSync(target);
      try {
        await initRepo(target);
      } catch (error) {
        // An empty folder git could not start in goes again, so the name stays free.
        rmSync(target, { recursive: true, force: true });
        throw error;
      }
      return this.addProject(target);
    },

    "project.clone": async ({ url, parent, name }) => {
      if (!url.trim()) throw new Error("Give the address of a repository to clone.");
      const target = this.newFolder(parent, name);
      try {
        await cloneRepo(url.trim(), target);
      } catch (error) {
        rmSync(target, { recursive: true, force: true });
        throw new Error(`Could not clone ${url.trim()}: ${errorText(error)}`, { cause: error });
      }
      return this.addProject(target);
    },

    "folder.list": ({ path }) => listFolders(path),

    "project.remove": ({ projectId }) => {
      for (const thread of this.threads.values()) {
        if (thread.projectId === projectId && !thread.parentId) this.deleteThreadTree(thread.id);
      }
      this.unwatchGit(projectId);
      this.projects.delete(projectId);
      this.store.deleteProject(projectId);
      this.emitProjects();
      return null;
    },

    "project.update": ({ projectId, reviewInstructions }) => {
      if (reviewInstructions === undefined) return this.project(projectId);
      return this.setProjectReview(projectId, reviewInstructions, []);
    },

    "project.openInEditor": ({ projectId }) => {
      this.openInEditor(this.projectPath(projectId));
      return null;
    },

    "sessions.list": () => this.listSessions(),

    "sessions.inspect": async ({ provider, sessionId }) =>
      this.placeOf((await this.foundSession(provider, sessionId)).cwd),

    "sessions.import": ({ provider, sessionId, mode }) => this.bringIn(provider, sessionId, mode),

    "thread.create": async ({ projectId, settings, message, workspace }) => {
      if (projectId) this.projectPath(projectId);
      let thread = this.newThread(projectId, this.threadSettings(settings));
      if (projectId && workspace) thread = { ...thread, workspace };
      // Work sent off to a worktree is a task from the start.
      if (projectId && workspace === "worktree" && message) {
        thread = todoTask(thread, itemFrom(message), Date.now());
      }
      const runtime = this.adoptThread(thread);
      this.settingsUsed(thread.settings);
      if (message) {
        try {
          await this.prepareWorkspace(thread.id);
        } catch (error) {
          // Nothing started, so nothing stays: the person still has what they wrote.
          this.deleteThreadTree(thread.id);
          throw error;
        }
        await runtime.send(message);
      }
      return runtime.thread;
    },

    "thread.open": ({ threadId }, client) => {
      const runtime = this.runtime(threadId);
      client.open.add(threadId);
      return {
        thread: runtime.thread,
        items: runtime.items(),
        queue: runtime.queued(),
        jobs: runtime.backgroundJobs(),
      };
    },

    "thread.close": ({ threadId }, client) => {
      client.open.delete(threadId);
      return null;
    },

    "thread.send": async ({ threadId, message, mode }) => {
      if (this.merging.has(threadId)) {
        throw new Error("Its work is being merged. Send this once that's done.");
      }
      await this.prepareWorkspace(threadId);
      await this.runtime(threadId).send(message, mode);
      return null;
    },

    "thread.interrupt": async ({ threadId }) => {
      await this.runtime(threadId).interrupt();
      return null;
    },

    "thread.update": ({ threadId, title, settings, pinned, archived, workspace }) => {
      const runtime = this.runtime(threadId);
      if (workspace && workspace !== runtime.thread.workspace) {
        if (runtime.thread.startedAt !== undefined || this.preparing.has(threadId)) {
          throw new Error("It has started, so where it works is settled.");
        }
        if (!runtime.thread.projectId)
          throw new Error("A thread without a project works on its own.");
        runtime.replace({ ...runtime.thread, workspace });
        if (runtime.thread.task) this.workspaceUsed(workspace);
      }
      return runtime.update({ title, settings, pinned, archived });
    },

    "thread.delete": ({ threadId }) => {
      this.deleteThreadTree(threadId);
      return null;
    },

    "thread.openInEditor": ({ threadId }) => {
      const thread = this.threads.get(threadId);
      if (!thread) throw new Error("The thread is gone.");
      this.openInEditor(this.workDir(thread));
      return null;
    },

    "thread.changes": async ({ threadId }) => {
      const thread = this.threads.get(threadId);
      if (!thread) throw new Error("The thread is gone.");
      const root = this.rootOf(thread);
      const worktree = root.worktree;
      if (worktree && worktree.mergedAt === undefined) {
        if (!existsSync(worktree.path)) return { against: worktree.base, files: [] };
        const changes = await changesIn(worktree.path, worktree.base ?? worktree.from);
        return { ...(worktree.base ? { against: worktree.base } : {}), ...changes };
      }
      if (root.origin) {
        if (!(await repoOf(root.origin.cwd))) return { files: [] };
        return changesIn(root.origin.cwd, undefined);
      }
      // A thread without a project works in a folder of its own, which no repository holds.
      if (!root.projectId) return { files: [] };
      const folder = this.projectPath(root.projectId);
      if (!(await repoOf(folder))) return { files: [] };
      return changesIn(folder, undefined);
    },

    "thread.merge": async ({ threadId }) => {
      const runtime = this.runtime(threadId);
      const thread = runtime.thread;
      const worktree = thread.worktree;
      if (!worktree || worktree.mergedAt !== undefined || !thread.projectId) {
        throw new Error("This thread has no worktree to merge.");
      }
      const base = worktree.base;
      if (!base) {
        throw new Error(
          "It started from a commit, not a branch, so there is no branch to merge into.",
        );
      }
      if (runtime.running) {
        throw new Error("The agent is still working. Wait for it to finish, or stop it first.");
      }
      if (this.reviewsOf(threadId).some((review) => this.runtimes.get(review.id)?.running)) {
        throw new Error(
          "A review of it is still running. Wait for it to finish, or stop it first.",
        );
      }
      const project = this.project(thread.projectId);
      const repo = await repoOf(project.path);
      if (repo?.branch !== base) {
        const checkedOut = repo?.branch
          ? `has ${repo.branch} checked out`
          : "has no branch checked out";
        throw new Error(`${project.name} ${checkedOut}. Check out ${base} there to merge into it.`);
      }
      if (this.merging.has(threadId)) throw new Error("It is being merged already.");
      this.merging.add(threadId);
      try {
        if (existsSync(worktree.path)) await commitAll(worktree.path, thread.title);
        const result = await mergeBranch(project.path, worktree.branch);
        if (!result.merged) return { merged: false, base, conflicts: result.conflicts };
        // The work is on the base branch now. What follows tidies up, and when it fails, the
        // merge still stands.
        // The agent's process works in the worktree, and Windows can't remove a folder a
        // process is in. A later turn starts afresh, in the project's folder.
        await runtime.forgetSession();
        for (const review of this.reviewsOf(threadId)) {
          await this.runtimes.get(review.id)?.forgetSession();
        }
        let left = "";
        try {
          if (existsSync(worktree.path)) await removeWorktree(project.path, worktree.path);
          await deleteBranch(project.path, worktree.branch);
        } catch (error) {
          log("app", `could not tidy up after merging ${worktree.branch}`, errorText(error));
          left = existsSync(worktree.path)
            ? ` Its worktree at ${worktree.path} is still there, as something has it open. Remove it once that's closed.`
            : ` The branch ${worktree.branch} is still there.`;
        }
        const now = Date.now();
        let next: Thread = { ...runtime.thread, worktree: { ...worktree, mergedAt: now } };
        if (next.task) next = moved(next, "done", now);
        runtime.replace(next);
        runtime.note(
          left
            ? `Merged ${worktree.branch} into ${base}.${left}`
            : `Merged ${worktree.branch} into ${base}, and removed its worktree.`,
        );
      } finally {
        this.merging.delete(threadId);
      }
      this.inBackground(() => this.refreshGit(project.id));
      return { merged: true, thread: runtime.thread };
    },

    "task.create": ({ projectId, message, status, settings, workspace }) => {
      this.projectPath(projectId);
      const thread = todoTask(
        this.newThread(projectId, this.threadSettings(settings)),
        itemFrom(message),
        Date.now(),
        status,
      );
      if (workspace) this.workspaceUsed(workspace);
      return this.adoptThread(workspace ? { ...thread, workspace } : thread).thread;
    },

    "task.move": ({ threadId, status }) => {
      const runtime = this.runtime(threadId);
      return runtime.replace(moved(runtime.thread, status, Date.now()));
    },

    "task.merge": async ({ threadId, from }) => {
      const runtime = this.runtime(threadId);
      const sources = from.map((id) => {
        const source = this.threads.get(id);
        if (!source) throw new Error("A task to fold in is gone.");
        return source;
      });
      const { thread, added } = merged(runtime.thread, sources, Date.now());
      for (const source of sources) this.deleteThreadTree(source.id);
      runtime.replace(thread);
      // A task under way hears about the new work. One still in To do starts with all of it.
      if (thread.startedAt !== undefined) {
        await runtime.send({
          text: addedPrompt(added),
          images: added.flatMap((item) => item.images ?? []),
        });
      }
      return runtime.thread;
    },

    "task.split": ({ threadId, itemId }) => {
      const runtime = this.runtime(threadId);
      const { thread, item } = split(runtime.thread, itemId, Date.now());
      runtime.replace(thread);
      const todo = todoTask(
        this.newThread(thread.projectId, thread.settings),
        item,
        Date.now(),
        thread.task?.status === "backlog" ? "backlog" : "todo",
      );
      // Split off a task nobody started, it keeps the choice made for where it works.
      const kept =
        thread.startedAt === undefined && thread.workspace ? { workspace: thread.workspace } : {};
      return this.adoptThread({ ...todo, ...kept }).thread;
    },

    "review.start": ({ threadId }) => this.startReview(threadId, false),

    "review.decide": async ({ reviewId, findingId, decision }) => {
      const runtime = this.runtime(reviewId);
      const { review, parentId } = runtime.thread;
      if (!review || !parentId) throw new Error("That review is gone.");
      const next = decided(review, findingId, decision);
      runtime.replace({ ...runtime.thread, review: next });
      const finding = next.findings.find((entry) => entry.id === findingId);
      if (decision === "fix" && finding) {
        try {
          await this.sendToTask(parentId, { text: fixAnywayMessage(finding), images: [] });
        } catch (error) {
          // Unsent, it isn't decided: the person can ask again.
          const current = runtime.thread.review;
          if (current)
            runtime.replace({ ...runtime.thread, review: undecided(current, findingId) });
          throw error;
        }
      }
      return null;
    },

    "queue.remove": ({ threadId, queueId }) => {
      this.runtime(threadId).removeQueued(queueId);
      return null;
    },

    "queue.steer": async ({ threadId, queueId }) => {
      await this.runtime(threadId).steerQueued(queueId);
      return null;
    },

    "approval.respond": ({ threadId, itemId, decision }) => {
      this.runtime(threadId).respondApproval(itemId, decision);
      return null;
    },

    "question.respond": ({ threadId, itemId, answers }) => {
      this.runtime(threadId).respondQuestion(itemId, answers);
      return null;
    },

    "job.stop": async ({ threadId, jobId }) => {
      await this.runtime(threadId).stopJob(jobId);
      return null;
    },

    "attachment.upload": ({ name, mime, data }) => {
      const ref = this.keepFile(Buffer.from(data, "base64"), mime, name);
      if (!ref) throw new Error("Only PNG, JPEG, GIF and WebP images can be attached.");
      return ref;
    },

    "settings.update": (changes) => {
      this.settings = { ...this.settings, ...changes };
      this.store.saveSettings(this.settings);
      this.emit({ type: "settings", settings: this.settings });
      return this.settings;
    },

    "providers.refresh": () => this.refreshProviders(),

    "commands.list": ({ provider, projectId }) =>
      this.projectCommands.get(`${provider}:${projectId ?? ""}`) ??
      this.providerCommands.get(provider) ??
      [],
  };

  /** Where an attachment's file is, for the HTTP server. */
  attachmentFile(id: string): { path: string; mime: string } | undefined {
    const attachment = this.store.attachment(id);
    return attachment ? { path: attachment.path, mime: attachment.mime } : undefined;
  }

  /**
   * A file of a page the agent showed, for the HTTP server: the page itself when `path` is
   * empty, else a file beside it that it loads.
   */
  pageFile(id: string, path: string): { path: string; mime: string; page: boolean } | undefined {
    const attachment = this.store.attachment(id);
    if (attachment?.mime !== "text/html") return undefined;
    if (!path) return { path: attachment.path, mime: "text/html; charset=utf-8", page: true };
    const file = fileInFolder(dirname(attachment.path), path);
    const mime = file && pageFileType(file);
    return file && mime ? { path: file, mime, page: false } : undefined;
  }

  /** An image file on this machine, for the HTTP server. Anything else is not served. */
  imageFile(path: string): { path: string; mime: string } | undefined {
    const mime = imageType(path);
    return mime && isAbsolute(path) ? { path, mime } : undefined;
  }
}

/** What the person wrote in a thread, oldest first: their messages, not the app's. */
/** What shows where a conversation brought in from another app carries on in dodocode. */
function broughtNotice(app: string, mode: OriginMode, place: SessionPlace): string {
  if (place.folderGone) {
    return `Brought in from ${app}. The folder it worked in is gone, so it can't carry on here.`;
  }
  return mode === "same"
    ? `Brought in from ${app}. It carries on the same conversation from here.`
    : `Brought in from ${app} as a copy. It goes its own way from here; the original stays in ${app}.`;
}

/** The checkout a folder is in, and its repository's main checkout. Unset outside a repository. */
async function checkoutOf(folder: string): Promise<Checkout | undefined> {
  const repo = await repoOf(folder).catch(() => undefined);
  if (!repo) return undefined;
  const main = await mainCheckout(folder).catch(() => undefined);
  return { root: repo.root, main: main ?? repo.root };
}

/** A project, as the place a conversation from another app goes in. */
function known(project: Project): SessionPlace {
  return { project: { id: project.id, name: project.name, path: project.path } };
}

/** When the first and last of some items happened, or `fallback` when none says. */
function span(list: readonly Item[], fallback: number): { first: number; last: number } {
  const times = list.map((item) => item.createdAt).filter((at) => at > 0);
  return times.length === 0
    ? { first: fallback, last: fallback }
    : {
        first: times.reduce((a, b) => Math.min(a, b)),
        last: times.reduce((a, b) => Math.max(a, b)),
      };
}

function personsMessages(items: readonly Item[]): string[] {
  return items.flatMap((item) => (item.type === "user" && !item.app ? [item.text] : []));
}

/** The images a task's work rests on: what it covers, and what the person sent along the way. */
function taskImages(task: Thread, items: readonly Item[]): ImageRef[] {
  const images = [
    ...(task.task?.covers.flatMap((item) => item.images ?? []) ?? []),
    ...items.flatMap((item) => (item.type === "user" && !item.app ? item.images : [])),
  ];
  const unique = [...new Map(images.map((image) => [image.id, image])).values()];
  return unique.slice(0, REVIEW_IMAGES);
}

/** Where a project's review file is: absolute, or in the first folder that has it. */
function instructionsFile(path: string, folders: readonly string[]): string | undefined {
  const candidates = isAbsolute(path) ? [path] : folders.map((folder) => resolve(folder, path));
  return candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}
