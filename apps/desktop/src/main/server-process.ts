// Runs the dodocode server (apps/server) in an Electron utility process, and restarts it if it
// stops. The renderer talks to it over a WebSocket on 127.0.0.1, with a token made here.

import { randomBytes } from "node:crypto";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { app, utilityProcess, type UtilityProcess } from "electron";
import type { ServerInfo } from "../preload/bridge";

const SHUTDOWN_GRACE_MS = 6000;
const MAX_RESTART_DELAY_MS = 30_000;
/** A server that ran this long before it stopped restarts at once. */
const HEALTHY_RUN_MS = 60_000;

export class ServerProcess {
  private token = randomBytes(24).toString("hex");
  /** Kept across restarts, so a page that reconnects finds the server where it was. */
  private port = 0;
  private child: UtilityProcess | undefined;
  private address: ServerInfo | undefined;
  private waiting: Array<(info: ServerInfo) => void> = [];
  private failures = 0;
  private stopping = false;
  private logFile: WriteStream | undefined;

  /** `profile` is where the server writes a CPU profile of its run (apps/server/src/profile.ts). */
  constructor(private profile?: string) {}

  /** The server's log, beside the app's other logs. Opened once the app knows where they go. */
  private get log(): WriteStream {
    if (!this.logFile) {
      const logs = app.getPath("logs");
      mkdirSync(logs, { recursive: true });
      this.logFile = createWriteStream(join(logs, "server.log"), { flags: "a" });
    }
    return this.logFile;
  }

  /** The server's address once it listens, waiting through a start or restart. */
  info(): Promise<ServerInfo> {
    if (this.address) return Promise.resolve(this.address);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  start(): void {
    if (this.stopping) return;
    const startedAt = Date.now();
    const child = utilityProcess.fork(join(import.meta.dirname, "server.js"), [], {
      serviceName: "dodocode server",
      stdio: "pipe",
      env: {
        ...process.env,
        DODOCODE_DATA_DIR: app.getPath("userData"),
        DODOCODE_TOKEN: this.token,
        DODOCODE_PORT: String(this.port),
        ...(this.profile ? { DODOCODE_CPU_PROFILE: this.profile } : {}),
      },
    });
    this.child = child;
    const echo = (chunk: Buffer) => {
      this.log.write(chunk);
      if (!app.isPackaged) process.stderr.write(chunk);
    };
    child.stdout?.on("data", echo);
    child.stderr?.on("data", echo);

    child.on("message", (message: { type?: string; port?: number } | undefined) => {
      if (message?.type !== "ready" || typeof message.port !== "number") return;
      this.port = message.port;
      this.address = {
        url: `ws://127.0.0.1:${message.port}/ws`,
        httpUrl: `http://127.0.0.1:${message.port}`,
        token: this.token,
      };
      for (const resolve of this.waiting.splice(0)) resolve(this.address);
    });

    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.address = undefined;
      if (this.stopping) return;
      this.log.write(`[main] the server stopped with exit code ${code}\n`);
      this.failures = Date.now() - startedAt > HEALTHY_RUN_MS ? 0 : this.failures + 1;
      const delay =
        this.failures === 0 ? 0 : Math.min(MAX_RESTART_DELAY_MS, 500 * 2 ** this.failures);
      setTimeout(() => this.start(), delay);
    });
  }

  /** Asks the server to finish and stop, and kills it if it takes too long. */
  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (child) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, SHUTDOWN_GRACE_MS);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.postMessage({ type: "shutdown" });
      });
    }
    this.logFile?.end();
  }
}
