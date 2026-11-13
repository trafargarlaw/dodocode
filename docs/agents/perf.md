# Performance work

`pnpm trace` records the app, and `pnpm perfq` reads the recordings
([tools/perfq](../../tools/perfq/README.md)). What matters most is the UI in use: how long a click
or key press takes to show its result, and the stutters while it runs. Launch comes second.

Every speedup starts from a measurement and ends with a comparison: record before the change and
after it, and report what moved.

## Recording on a copy

The app runs one instance per data folder, and the person's own copy is likely open on theirs: a
recording launched on it only hands over to the open app. Record on a copy instead. Copy the dev
data folder to `<copy>-dev`, then pass `-- --user-data-dir=<copy>` without the suffix, because an
app not yet packaged adds `-dev` itself. The folder is `%APPDATA%/dodocode-dev` on Windows,
`~/Library/Application Support/dodocode-dev` on macOS, and `~/.config/dodocode-dev` on Linux. Leave
the person's app and data folder alone.

Put recordings outside the repository: each one is tens of MB. `pnpm trace` builds the app first.

## Finding what is slow in use

1. **Record a session.** From the root:

   ```sh
   pnpm trace --out <scratch>/session --until-closed -- --user-data-dir=<copy>
   ```

   Use the app, then close its window. The recording is written as the window closes, and holds
   about 4 busy minutes. To drive the app yourself, add `--remote-debugging-port=<a free port>` and
   send input through the DevTools protocol (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`).
   Close it from outside, as the close button does. A `window.close()` from the page ends it before
   the recording is written.

   Done when `pnpm trace` prints its `read it with:` line.

2. **Read it.** Run `pnpm perfq slow <trace>`. It lists the clicks and key presses that took over
   100ms (`--min`) to show their result, split into waiting, handlers and drawing, and the stutters
   (frames of 50ms or more), each with the code that ran. Actions are named by the marks
   `apps/desktop/src/renderer/perf.ts` leaves. Follow its `next:` lines to go function by function.

   Done when, for each slow action, you can name its time, which part took it, and the function
   and `file:line` behind it.

3. **Repeat before calling it slow.** One session is one sample: a garbage collection or a cold
   first use can make any action slow once. Do the action several times, in a second session too,
   and report what holds across them.

## Measuring a change

1. **Record the baseline.** For a click or key press, record a session as above and do the action
   several times. For launch, or the work a span times, record runs:

   ```sh
   pnpm trace --out <scratch>/before -- --user-data-dir=<copy>
   ```

   This launches the app 5 times for 8 seconds each. Done when the folder holds 5 runs, each a
   `.trace.json` with its `.server.cpuprofile` and `.maps.json`.

2. **Find the cost.** Run `pnpm perfq summary <scratch>/before` and follow its `next:` lines.
   There are three threads: the renderer is the UI, the browser is Electron's main process, and
   the server is `apps/server`. To time a stretch of renderer code that no span covers yet, wrap it
   in a span from `apps/desktop/src/renderer/perf.ts`.

   Done when you can name the function, its `file:line`, its milliseconds per run, and whether it
   sits inside what the person waits on: a slow action, `startup`, a `call:*`, a `feed:*`.

3. **Change one thing**, then record the same way: the same actions, or the same `--runs` and
   `--seconds`, into `<scratch>/after`.

4. **Compare.** For runs, `pnpm perfq diff <scratch>/before <scratch>/after`. Done when each claim
   you report rests on a row with a verdict of less or more. For a session, compare the action's
   typical and slowest times in `perfq slow`, and report every time you measured, not the best.
   Report what did not move as well. Busy time can drop while the wait stays put, when the work
   was off the path the person waits on.

## Noise

Recording slows the app a little, so compare recordings with each other, not with times measured
without one. The first launch after a build starts cold and runs slower. Each set of runs opens
with one, so keeping the run counts equal keeps the comparison fair. Medians absorb one odd run.
To look at a single run, name its `.trace.json` alone.
