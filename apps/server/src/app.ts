// The server's state and the methods clients call. Transport lives in main.ts.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import type { FSWatcher } from "node:fs";
import { basename, extname, join } from "node:path";

import { addedPrompt, folderNameProblem } from "@dodocode/protocol";
import type {
  Method,
  Params,
  Project,
  ProviderId,
  ProviderInfo,
  Result,
  ServerEvent,
  Settings,
  Thread,
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
  mergeBranch,
  removeWorktree,
  repoOf,
  restoreWorktree,
} from "./git";
import { expandPath, listFolders } from "./folders";
import { ClaudeProvider } from "./providers/claude";
import { CodexProvider } from "./providers/codex";
import type { Provider } from "./providers/types";
import { Store } from "./store";
import { itemFrom, merged, moved, promoted, split, todoTask } from "./tasks";
import { ThreadRuntime, type ThreadContext } from "./thread";
import { errorText, log, newId } from "./util";

export interface Client {
  send(event: ServerEvent): void;
  /** Threads whose items this client receives. */
  open: Set<string>;
}

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
};

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
  private providers = new Map<ProviderId, Provider>();
  private providerInfo = new Map<ProviderId, ProviderInfo>();
  private projects = new Map<string, Project>();
  private threads = new Map<string, Thread>();
  private runtimes = new Map<string, ThreadRuntime>();
  private settings: Settings;
  private clients = new Set<Client>();

  constructor(dataDir: string) {
    this.dataDir = dataDir;
    this.attachmentsDir = join(dataDir, "attachments");
    mkdirSync(this.attachmentsDir, { recursive: true });
    this.scratchDir = join(dataDir, "scratch");
    this.worktreesDir = join(dataDir, "worktrees");
    this.store = new Store(join(dataDir, "dodocode.db"));
    this.settings = { ...DEFAULT_SETTINGS, ...this.store.settings() };
    for (const provider of [new ClaudeProvider(), new CodexProvider()]) {
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
      }
    }
    void this.refreshProviders();
    for (const project of this.projects.values()) void this.refreshGit(project.id);
    log(
      "app",
      `data in ${this.dataDir}: ${this.projects.size} projects, ${this.threads.size} threads`,
    );
  }

  async dispose(): Promise<void> {
    for (const { watcher } of this.gitWatchers.values()) watcher.close();
    this.gitWatchers.clear();
    await Promise.all([...this.runtimes.values()].map((runtime) => runtime.dispose()));
    this.store.close();
  }

  // Clients

  connect(client: Client): () => void {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  emit(event: ServerEvent, threadId?: string): void {
    if (event.type === "thread") this.threads.set(event.thread.id, event.thread);
    for (const client of this.clients) {
      if (threadId && !client.open.has(threadId)) continue;
      client.send(event);
    }
    const item = event.type === "item" ? event.item : undefined;
    if (item?.type === "tool" && item.kind === "edit" && item.status === "done") {
      this.filesChanged(item.threadId);
    }
    if (item?.type === "turn_end") void this.countWork(item.threadId);
  }

  /** A chat whose agent, or one of its subagents, changed files becomes a task. */
  private filesChanged(threadId: string): void {
    let root = this.threads.get(threadId);
    while (root?.parentId) root = this.threads.get(root.parentId);
    if (!root) return;
    const runtime = this.runtime(root.id);
    const next = promoted(runtime.thread, Date.now());
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
    this.watchGit(projectId, repo?.gitDir);
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
        timer = setTimeout(() => void this.refreshGit(projectId), 150);
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
          info = await provider.check();
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

    "project.openInEditor": ({ projectId }) => {
      this.openInEditor(this.projectPath(projectId));
      return null;
    },

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
      void this.refreshGit(project.id);
      return { merged: true, thread: runtime.thread };
    },

    "task.create": ({ projectId, message, settings, workspace }) => {
      this.projectPath(projectId);
      const thread = todoTask(
        this.newThread(projectId, this.threadSettings(settings)),
        itemFrom(message),
        Date.now(),
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
      const todo = todoTask(this.newThread(thread.projectId, thread.settings), item, Date.now());
      // Split off a task nobody started, it keeps the choice made for where it works.
      const kept =
        thread.startedAt === undefined && thread.workspace ? { workspace: thread.workspace } : {};
      return this.adoptThread({ ...todo, ...kept }).thread;
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
      const extension = IMAGE_EXTENSIONS[mime];
      if (!extension) throw new Error("Only PNG, JPEG, GIF and WebP images can be attached.");
      const id = newId();
      const path = join(this.attachmentsDir, `${id}${extension}`);
      writeFileSync(path, Buffer.from(data, "base64"));
      const ref = { id, name: name || `image${extname(path)}`, mime };
      this.store.saveAttachment({ ...ref, path });
      return ref;
    },

    "settings.update": (changes) => {
      this.settings = { ...this.settings, ...changes };
      this.store.saveSettings(this.settings);
      this.emit({ type: "settings", settings: this.settings });
      return this.settings;
    },

    "providers.refresh": () => this.refreshProviders(),
  };

  /** Where an attachment's file is, for the HTTP server. */
  attachmentFile(id: string): { path: string; mime: string } | undefined {
    const attachment = this.store.attachment(id);
    return attachment ? { path: attachment.path, mime: attachment.mime } : undefined;
  }
}
