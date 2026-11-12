// The server's state and the methods clients call. Transport lives in main.ts.

import { spawn } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";

import { addedPrompt } from "@dodocode/protocol";
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
} from "@dodocode/protocol";

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
};

export class App implements ThreadContext {
  readonly store: Store;
  private dataDir: string;
  private attachmentsDir: string;
  /** Where threads without a project work, each in a folder of its own. */
  private scratchDir: string;
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
    log(
      "app",
      `data in ${this.dataDir}: ${this.projects.size} projects, ${this.threads.size} threads`,
    );
  }

  async dispose(): Promise<void> {
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
    if (thread.projectId) return this.projectPath(thread.projectId);
    // A subagent works where the thread that started it works.
    let root = thread;
    while (root.parentId) {
      const parent = this.threads.get(root.parentId);
      if (!parent) break;
      root = parent;
    }
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

  private projectPath(projectId: string): string {
    const project = this.projects.get(projectId);
    if (!project) throw new Error("The project is gone.");
    return project.path;
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
    const scratch = this.threads.get(threadId)?.projectId ? undefined : threadId;
    for (const id of ids) {
      const runtime = this.runtimes.get(id);
      if (runtime) void runtime.dispose();
      this.runtimes.delete(id);
      this.threads.delete(id);
      this.emit({ type: "thread.removed", threadId: id });
    }
    this.store.deleteThread(threadId);
    // The folder made for a thread without a project goes with it.
    if (scratch) {
      try {
        rmSync(join(this.scratchDir, scratch), { recursive: true, force: true });
      } catch (error) {
        log("app", "could not delete the folder of a thread", errorText(error));
      }
    }
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

    "project.add": ({ path }) => {
      const full = resolve(path);
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
      this.emitProjects();
      return project;
    },

    "project.remove": ({ projectId }) => {
      for (const thread of this.threads.values()) {
        if (thread.projectId === projectId && !thread.parentId) this.deleteThreadTree(thread.id);
      }
      this.projects.delete(projectId);
      this.store.deleteProject(projectId);
      this.emitProjects();
      return null;
    },

    "project.openInEditor": ({ projectId }) => {
      this.openInEditor(this.projectPath(projectId));
      return null;
    },

    "thread.create": async ({ projectId, settings, message }) => {
      if (projectId) this.projectPath(projectId);
      const thread = this.newThread(projectId, this.threadSettings(settings));
      const runtime = this.adoptThread(thread);
      this.settingsUsed(thread.settings);
      if (message) await runtime.send(message);
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
      await this.runtime(threadId).send(message, mode);
      return null;
    },

    "thread.interrupt": async ({ threadId }) => {
      await this.runtime(threadId).interrupt();
      return null;
    },

    "thread.update": ({ threadId, title, settings, pinned, archived }) =>
      this.runtime(threadId).update({ title, settings, pinned, archived }),

    "thread.delete": ({ threadId }) => {
      this.deleteThreadTree(threadId);
      return null;
    },

    "task.create": ({ projectId, message, settings }) => {
      this.projectPath(projectId);
      const thread = todoTask(
        this.newThread(projectId, this.threadSettings(settings)),
        itemFrom(message),
        Date.now(),
      );
      return this.adoptThread(thread).thread;
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
      return this.adoptThread(todo).thread;
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
