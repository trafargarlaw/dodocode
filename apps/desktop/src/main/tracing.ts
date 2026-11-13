// Records a performance trace of the app, for `perfq` (tools/perfq) to read. It runs only when
// DODOCODE_TRACE names a folder:
//
//   DODOCODE_TRACE=<folder>          record from launch until the window closes or the app quits
//   DODOCODE_TRACE_SECONDS=<n>       stop after n seconds and quit, for repeated runs
//
// Each run writes these files to the folder, named by the time it started:
//   <run>.trace.json         the window's trace, as the DevTools Performance panel saves one: tasks,
//                            frames, the renderer's CPU samples and the spans in renderer/perf.ts,
//                            from the page, the main process and the GPU process
//   <run>.server.cpuprofile  the server's CPU samples (apps/server/src/profile.ts)
//   <run>.maps.json          the source map of each bundle that ran, saved in maps/, so perfq
//                            finds the run's source lines after a rebuild moves them
//
// It records through the DevTools protocol, which writes JSON. contentTracing writes Perfetto's
// protobuf format, which DevTools cannot open and perfq does not read.

import { createHash } from "node:crypto";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { app, type Debugger, type WebContents } from "electron";

const CATEGORIES = [
  // Tasks, function calls, layout, paint and frames, as the Performance panel records them.
  "toplevel",
  "devtools.timeline",
  "disabled-by-default-devtools.timeline",
  "disabled-by-default-devtools.timeline.frame",
  "v8.execute",
  // CPU samples, with the call stack of each.
  "disabled-by-default-v8.cpu_profiler",
  // performance.measure() in the renderer.
  "blink.user_timing",
  "loading",
  "latencyInfo",
];

/** How long to wait for the GPU process before recording without it. */
const GPU_WAIT_MS = 3000;
const GPU_POLL_MS = 20;

/**
 * Waits for the GPU process. A recording takes in only the processes running when it starts, and
 * the GPU process starts once the first window needs it: started before it, the trace would miss
 * how frames are drawn and reach the screen.
 */
async function gpuStarted(): Promise<boolean> {
  const deadline = Date.now() + GPU_WAIT_MS;
  while (Date.now() < deadline) {
    if (app.getAppMetrics().some((m) => m.type === "GPU")) return true;
    await new Promise((resolve) => setTimeout(resolve, GPU_POLL_MS));
  }
  return false;
}

/** The trace buffer. A busy minute fills about 100 MB. */
const BUFFER_KB = 400 * 1024;
const READ_CHUNK = 4 * 1024 * 1024;
/** How long a full buffer may take to come back once the recording ends. */
const END_MS = 30_000;

export interface TraceSettings {
  dir: string;
  /** Stop after this long and quit; undefined records until the window closes. */
  seconds: number | undefined;
}

export function traceSettings(): TraceSettings | undefined {
  const dir = process.env.DODOCODE_TRACE;
  if (!dir) return undefined;
  const seconds = Number(process.env.DODOCODE_TRACE_SECONDS);
  return { dir, seconds: seconds > 0 ? seconds : undefined };
}

export class TraceRecorder {
  private readonly run = new Date().toISOString().replace(/[:.]/g, "-");
  private session: Debugger | undefined;
  private stopping: Promise<void> | undefined;
  /** True once the trace is written, or failed to be. */
  finished = false;

  constructor(private settings: TraceSettings) {
    mkdirSync(settings.dir, { recursive: true });
  }

  /** Where the server writes its CPU profile, when it stops. */
  get serverProfile(): string {
    return join(this.settings.dir, `${this.run}.server.cpuprofile`);
  }

  /** True until a window is given to record: only the first one is. */
  get waiting(): boolean {
    return !this.session && !this.finished;
  }

  /**
   * Starts recording the window's trace. Call it before the window loads its page, so the trace
   * holds the whole launch. Only the first window is recorded.
   */
  async attach(contents: WebContents): Promise<void> {
    if (this.session) return;
    const session = contents.debugger;
    this.session = session;
    if (!(await gpuStarted())) this.report("recording without the GPU process: it did not start");
    try {
      session.attach("1.3");
      await session.sendCommand("Tracing.start", {
        transferMode: "ReturnAsStream",
        streamFormat: "json",
        traceConfig: {
          recordMode: "recordUntilFull",
          traceBufferSizeInKb: BUFFER_KB,
          includedCategories: CATEGORIES,
          excludedCategories: ["*"],
        },
      });
    } catch (error) {
      this.report(`could not start: ${String(error)}`);
      this.finished = true;
      return;
    }
    const { seconds } = this.settings;
    if (seconds !== undefined) setTimeout(() => app.quit(), seconds * 1000);
  }

  /** Stops recording and writes the trace. Safe to call more than once. */
  stop(): Promise<void> {
    this.stopping ??= this.write().finally(() => {
      this.finished = true;
    });
    return this.stopping;
  }

  private async write(): Promise<void> {
    const session = this.session;
    if (!session || this.finished) return;
    const path = join(this.settings.dir, `${this.run}.trace.json`);
    try {
      // The trace comes back as an event after `Tracing.end`. It never comes when the page goes
      // away first, and the window waits on it to close, so a page gone or a wait too long ends it.
      const complete = new Promise<{ stream?: string; dataLossOccurred?: boolean }>(
        (resolve, reject) => {
          const done = () => {
            clearTimeout(timer);
            session.off("message", listen);
            session.off("detach", detached);
          };
          const listen = (_event: unknown, method: string, params: Record<string, unknown>) => {
            if (method !== "Tracing.tracingComplete") return;
            done();
            resolve(params);
          };
          const detached = (_event: unknown, reason: string) => {
            done();
            reject(new Error(`the page went away (${reason})`));
          };
          const timer = setTimeout(() => {
            done();
            reject(new Error(`the trace did not come back in ${END_MS / 1000} seconds`));
          }, END_MS);
          session.on("message", listen);
          session.on("detach", detached);
        },
      );
      // Together, so that `complete` failing while `Tracing.end` runs is caught here too.
      const [, { stream, dataLossOccurred }] = await Promise.all([
        session.sendCommand("Tracing.end"),
        complete,
      ]);
      if (!stream) throw new Error("the trace came back without its data");
      const file = createWriteStream(path);
      for (;;) {
        const chunk = (await session.sendCommand("IO.read", {
          handle: stream,
          size: READ_CHUNK,
        })) as {
          data: string;
          base64Encoded?: boolean;
          eof: boolean;
        };
        file.write(chunk.base64Encoded ? Buffer.from(chunk.data, "base64") : chunk.data);
        if (chunk.eof) break;
      }
      await session.sendCommand("IO.close", { handle: stream });
      await new Promise<void>((resolve, reject) =>
        file.end((error?: Error | null) => (error ? reject(error) : resolve())),
      );
      if (dataLossOccurred) this.report("the buffer filled up: the trace misses its last events");
      this.report(`wrote ${path}`);
    } catch (error) {
      this.report(`could not write ${path}: ${String(error)}`);
    } finally {
      if (session.isAttached()) session.detach();
    }
    try {
      this.saveMaps();
    } catch (error) {
      this.report(`could not save the source maps: ${String(error)}`);
    }
  }

  /**
   * Saves the source maps of the build that ran: each once in `maps/`, named by its content, and
   * which bundle each belongs to in `<run>.maps.json`. A packaged app ships no maps, and saves none.
   */
  private saveMaps(): void {
    const out = join(app.getAppPath(), "out");
    if (!existsSync(out)) return;
    const bundles: Record<string, string> = {};
    for (const entry of readdirSync(out, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".js.map") && !entry.endsWith(".cjs.map")) continue;
      const map = join(out, entry);
      const bytes = readFileSync(map);
      const saved = `maps/${createHash("sha256").update(bytes).digest("hex").slice(0, 16)}.map`;
      const target = join(this.settings.dir, saved);
      if (!existsSync(target)) {
        mkdirSync(join(this.settings.dir, "maps"), { recursive: true });
        writeFileSync(target, bytes);
      }
      bundles[map.slice(0, -".map".length).replaceAll("\\", "/")] = saved;
    }
    if (Object.keys(bundles).length === 0) return;
    const manifest = join(this.settings.dir, `${this.run}.maps.json`);
    writeFileSync(manifest, `${JSON.stringify(bundles, null, 2)}\n`);
  }

  private report(message: string): void {
    process.stderr.write(`[trace] ${message}\n`);
  }
}
