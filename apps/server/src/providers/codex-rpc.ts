// A `codex app-server` process: newline-delimited JSON-RPC over stdio, without the "jsonrpc"
// field. Requests go both ways; the server's requests must all be answered or its turn hangs.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { errorText, log } from "../util";
import { agentEnv } from "./env";

export class RpcError extends Error {
  code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export interface RpcHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  /** Answers a request from the server. Throw an RpcError to answer with an error. */
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  exited(reason: string): void;
}

export class CodexProcess {
  private child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private stderrTail = "";
  private alive = true;
  readonly ready: Promise<{ userAgent?: string }>;

  constructor(executable: string, handlers: RpcHandlers) {
    const shim = /\.(cmd|bat)$/i.test(executable);
    this.child = spawn(
      shim ? `"${executable}" app-server` : executable,
      shim ? [] : ["app-server"],
      {
        env: agentEnv(),
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: shim,
      },
    );
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on("line", (line) => this.receive(line, handlers));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-4000);
    });
    const exited = (reason: string) => {
      if (!this.alive) return;
      this.alive = false;
      const tail = this.stderrTail.trim().split("\n").slice(-5).join("\n");
      const message = tail ? `${reason}\n${tail}` : reason;
      for (const { reject } of this.pending.values()) reject(new Error(message));
      this.pending.clear();
      handlers.exited(message);
    };
    this.child.on("error", (error) => exited(`Codex could not start: ${errorText(error)}`));
    this.child.on("exit", (code, signal) =>
      exited(`Codex stopped (${signal ?? `exit code ${code}`}).`),
    );
    this.ready = this.initialize();
  }

  get running(): boolean {
    return this.alive;
  }

  private async initialize(): Promise<{ userAgent?: string }> {
    let result: { userAgent?: string } = {};
    try {
      result = (await this.request("initialize", {
        clientInfo: { name: "dodocode", title: "dodocode", version: "0.1.0" },
        capabilities: { experimentalApi: true, optOutNotificationMethods: ["turn/diff/updated"] },
      })) as { userAgent?: string };
    } catch (error) {
      if (!(error instanceof RpcError && /already initialized/i.test(error.message))) throw error;
    }
    this.notify("initialized");
    return result;
  }

  request(method: string, params: unknown = {}): Promise<unknown> {
    if (!this.alive) return Promise.reject(new Error("Codex is not running."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  kill(): void {
    if (!this.alive) return;
    this.child.stdin.end();
    this.child.kill();
  }

  private write(message: unknown): void {
    if (!this.alive) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private receive(line: string, handlers: RpcHandlers): void {
    const text = line.trim();
    if (!text) return;
    let message: {
      id?: number | string;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(text);
    } catch {
      log("codex", "unreadable line", text.slice(0, 200));
      return;
    }
    const params = (message.params ?? {}) as Record<string, unknown>;
    if (message.method && message.id !== undefined) {
      const id = message.id;
      // Answer off the reader, so a slow answer does not hold up the next notifications.
      void handlers
        .request(message.method, params)
        .then((result) => this.write({ id, result }))
        .catch((error: unknown) => {
          const code = error instanceof RpcError ? error.code : -32603;
          this.write({ id, error: { code, message: errorText(error) } });
        });
      return;
    }
    if (message.method) {
      try {
        handlers.notification(message.method, params);
      } catch (error) {
        log("codex", `could not handle ${message.method}`, error);
      }
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new RpcError(message.error.code, message.error.message));
      else pending.resolve(message.result);
    }
  }
}
