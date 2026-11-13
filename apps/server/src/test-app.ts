import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Item, Method, Params, Project, Result, Thread } from "@dodocode/protocol";

import { App, type Client } from "./app";
import type {
  FoundSession,
  Provider,
  ProviderCheck,
  ProviderSession,
  SessionHost,
  SessionSource,
  TurnMessage,
} from "./providers/types";
import { errorText } from "./util";

/** What a fake agent does in a turn. The turn ends when this is done, and fails if it throws. */
export type FakeTurn = (host: SessionHost, message: TurnMessage) => void | Promise<void>;

/** A conversation the fake agent had in another app: one message, and the agent's reply. */
export interface FakeConversation extends FoundSession {
  /** What the person said in it. */
  said: string;
  /** An image the person sent with it: a PNG, base64 encoded. */
  image?: string;
}

/**
 * An agent for tests that runs no model. Each turn does what the test set for the thread's
 * role. It stands in for Claude, the provider threads start with.
 */
export class FakeAgent implements Provider {
  readonly id = "claude";
  readonly label = "Fake agent";
  /** What a task's or a chat's agent does in a turn. */
  worker: FakeTurn = () => {};
  /** What a reviewer does in a turn. */
  reviewer: FakeTurn = () => {};
  /**
   * Its conversations in other apps, as they list. As with Claude, the sessions of dodocode's
   * own threads list too, and so does a copy once it is made.
   */
  elsewhere: FakeConversation[] = [];
  /** Set to make copying a conversation fail. */
  copyFails = false;
  private made = 0;
  readonly sessions: SessionSource = {
    list: () => Promise.resolve(this.elsewhere.toSorted((a, b) => b.updatedAt - a.updatedAt)),
    read: (id, history) => {
      const found = this.conversation(id);
      const main = history.main;
      main.clock.at = found.updatedAt;
      main.startTurn(false);
      const image = found.image ? history.keepImage(found.image, "image/png") : undefined;
      main.add({ type: "user", text: found.said, images: image ? [image] : [] });
      main.add({ type: "assistant", text: "Done.", streaming: false });
      main.endTurn("completed");
      return Promise.resolve({});
    },
    copy: (id) => {
      const found = this.conversation(id);
      if (this.copyFails) return Promise.reject(new Error("The copy could not be written."));
      const copy = { ...found, id: `${id}-copy`, app: "an Agent SDK app" };
      this.elsewhere.push(copy);
      return Promise.resolve(copy.id);
    },
  };

  private conversation(id: string): FakeConversation {
    const found = this.elsewhere.find((conversation) => conversation.id === id);
    if (!found) throw new Error(`The fake agent had no conversation ${id}.`);
    return found;
  }

  check(): Promise<ProviderCheck> {
    return Promise.resolve({
      id: this.id,
      label: this.label,
      status: "ready",
      models: [{ id: "fake", label: "Fake", efforts: [] }],
    });
  }

  createSession(host: SessionHost): ProviderSession {
    return {
      startTurn: (message) => {
        if (!host.resumeId) {
          const id = `session-${++this.made}`;
          host.saveResumeId(id);
          this.elsewhere.push({
            id,
            title: message.text,
            cwd: host.cwd,
            app: "an Agent SDK app",
            updatedAt: Date.now(),
            said: message.text,
          });
        }
        const turn = host.reviewing ? this.reviewer : this.worker;
        // As with a real agent, the turn runs on after `startTurn` returns.
        void Promise.resolve()
          .then(() => turn(host, message))
          .then(
            () => host.turnEnded({ status: "completed" }),
            (error: unknown) => host.turnEnded({ status: "failed", error: errorText(error) }),
          );
        return Promise.resolve();
      },
      steer: () => Promise.resolve(false),
      interrupt: () => Promise.resolve(),
      stopJob: () => Promise.resolve(),
      dispose: () => Promise.resolve(),
    };
  }
}

/** The app on data of its own, with a fake agent and one project. */
export interface TestApp {
  app: App;
  agent: FakeAgent;
  /** A git repository with one commit. */
  project: Project;
  /** A folder of the test's own, which holds the project's. */
  dir: string;
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
  /** The thread as the app has it now. */
  thread(threadId: string): Promise<Thread>;
  items(threadId: string): Promise<Item[]>;
  /** The text of the messages a thread was sent, the app's own included. */
  messages(threadId: string): Promise<string[]>;
  /** The notes the app wrote in a thread. */
  notes(threadId: string): Promise<string[]>;
  /** The names of the files the app keeps images in. */
  attachments(): string[];
  /** Runs git in the project's folder, and gives its output. */
  git(...args: string[]): string;
  /** Stops the app and starts it again on the same data, as the person quitting and coming back. */
  restart(): Promise<void>;
  close(): Promise<void>;
}

export async function testApp(): Promise<TestApp> {
  // The real path, as git gives it: on macOS the temporary folder is behind a link.
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "dodocode-app-")));
  const saved = { ...process.env };
  // The person's own git config (signing, hooks, a default branch) stays out of the test.
  writeFileSync(join(dir, "gitconfig"), "");
  Object.assign(process.env, {
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  const folder = join(dir, "project");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: folder, encoding: "utf8" });
  mkdirSync(folder);
  git("init", "-q", "-b", "main");
  writeFileSync(join(folder, "a.txt"), "one\n");
  git("add", "--all");
  git("commit", "-q", "-m", "start");

  const data = join(dir, "data");
  const agent = new FakeAgent();
  const client: Client = { send: () => {}, open: new Set() };
  let app = new App(data, [agent]);
  app.start();
  const call = async <M extends Method>(method: M, params: Params<M>) =>
    await app.call(method, params, client);
  const project = await call("project.add", { path: folder });
  const items = async (threadId: string) => (await call("thread.open", { threadId })).items;
  return {
    get app() {
      return app;
    },
    agent,
    project,
    dir,
    call,
    thread: async (threadId) => (await call("thread.open", { threadId })).thread,
    items,
    messages: async (threadId) =>
      (await items(threadId)).flatMap((item) => (item.type === "user" ? [item.text] : [])),
    notes: async (threadId) =>
      (await items(threadId)).flatMap((item) => (item.type === "notice" ? [item.text] : [])),
    attachments: () =>
      readdirSync(join(data, "attachments"), { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name),
    git,
    restart: async () => {
      await app.dispose();
      app = new App(data, [agent]);
      app.start();
    },
    close: async () => {
      await app.dispose();
      process.env = saved;
      rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
    },
  };
}
