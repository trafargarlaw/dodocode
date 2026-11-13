// Records performance traces of the built app, one per launch, for perfq (tools/perfq) to read.
// From the root, which builds the app first:
//
//   pnpm trace --out <folder> [--runs 5] [--seconds 8] [-- <arguments for the app>]
//   pnpm trace --out <folder> --until-closed [-- <arguments for the app>]
//
// Each run launches the app, records for --seconds and quits, through src/main/tracing.ts. With
// --until-closed it launches the app once and records while someone uses it, until its window
// closes: what `perfq slow` reads. The app runs one instance per data folder, so while it is open a run would only hand over to it:
// quit it first, or pass `-- --user-data-dir=<folder>` with a copy of its data (the app adds
// `-dev` to the folder's name).

import { spawn } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const USAGE =
  "pnpm trace --out <folder> [--runs 5] [--seconds 8 | --until-closed] [-- <arguments for the app>]";

const { values, positionals } = parseArgs({
  options: {
    out: { type: "string" },
    runs: { type: "string", default: "5" },
    seconds: { type: "string", default: "8" },
    "until-closed": { type: "boolean", default: false },
  },
  allowPositionals: true,
});
const untilClosed = values["until-closed"];
const runs = untilClosed ? 1 : Number(values.runs);
const seconds = Number(values.seconds);
if (!values.out || !(runs >= 1) || !(seconds > 0)) {
  console.error(`usage: ${USAGE}`);
  process.exit(1);
}

// pnpm runs a script in its package's folder, and says in INIT_CWD where it was called from.
const out = resolve(process.env.INIT_CWD ?? process.cwd(), values.out);
const desktop = join(dirname(fileURLToPath(import.meta.url)), "..");
// From Node, the electron package is the path of its executable.
const electron = createRequire(import.meta.url)("electron");
mkdirSync(out, { recursive: true });

const traces = () => readdirSync(out).filter((file) => file.endsWith(".trace.json"));

if (untilClosed) {
  console.log(
    "The app is open and recording. Use it as you normally do, then close its window. A trace holds about 4 busy minutes.",
  );
}
for (let run = 1; run <= runs; run += 1) {
  const before = traces();
  const code = await launch();
  const added = traces().filter((file) => !before.includes(file));
  if (added.length === 0) {
    console.error(
      `run ${run} wrote no trace (exit code ${code}). If the app is open, it took the launch over: quit it, or pass -- --user-data-dir=<a copy of its data>.`,
    );
    process.exit(1);
  }
  if (untilClosed) {
    console.log(`\nread it with: pnpm perfq slow ${join(out, added[0])}`);
    process.exit(0);
  }
  console.log(`run ${run} of ${runs} recorded`);
}
console.log(`\nread them with: pnpm perfq summary ${out}`);

/** Launches the app once and waits for it to quit. Only the recorder's own lines are shown. */
function launch() {
  return new Promise((done) => {
    const app = spawn(electron, [".", ...positionals], {
      cwd: desktop,
      env: {
        ...process.env,
        DODOCODE_TRACE: out,
        ...(untilClosed ? {} : { DODOCODE_TRACE_SECONDS: String(seconds) }),
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let pending = "";
    app.stderr.setEncoding("utf8");
    app.stderr.on("data", (chunk) => {
      const lines = (pending + chunk).split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) if (line.startsWith("[trace]")) console.log(line);
    });
    // A launch that hangs past its recording is stopped, and counts as a run without a trace.
    const timer = untilClosed ? undefined : setTimeout(() => app.kill(), (seconds + 60) * 1000);
    app.on("close", (code) => {
      clearTimeout(timer);
      done(code);
    });
  });
}
