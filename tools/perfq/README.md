# perfq

Answers questions about an app's performance from its traces, a few dozen lines per answer, small
enough for an agent (or a person) to read whole. A raw trace holds hundreds of thousands of events;
perfq answers one question at a time over them: which clicks and key presses were slow and why,
which thread was busy and with what, which functions took the time, what ran in each long task, and
whether a change made things faster.

It reads Chrome traces, as the DevTools Performance panel saves them, and V8 CPU profiles
(`.cpuprofile`). Several runs read together give medians, so one noisy launch does not decide the
answer.

## Running it

From the repository root, with Rust installed:

```sh
pnpm perfq slow <run>              # the slow clicks and key presses, and the stutters
pnpm perfq summary <runs>          # what each thread spent its time on
pnpm perfq diff <before> <after>   # whether a change made a difference
pnpm perfq --help                  # every command and option
```

A run is a file, or a folder of them. Answers are data: labelled fields, tables and ranked sections,
with no prose. `perfq --help` says what every field and column means. Each answer ends with `next:`
lines, the commands that look further into what it found.

To record dodocode's runs, see [docs/agents/perf.md](../../docs/agents/perf.md).

## Reading a slow moment

`slow` and `tasks` print each moment with one line per thread: the page (`renderer`), Electron's
main process (`browser`), and, when the trace has the GPU process, `gpu` and `viz`. `slow` adds an
interaction's `phases`. Which of them held the time says where to look:

| what the fields show                                     | where the time went                                         |
| -------------------------------------------------------- | ----------------------------------------------------------- |
| `renderer` and `browser` both mostly `off-cpu`           | Windows paused the app; nothing in its code                 |
| `waiting` large                                          | the page was busy with earlier work                         |
| `handlers` or `render` large, `renderer` busy on the CPU | the page's own work: its kinds and `self time`              |
| `renderer` `off-cpu` large, `fonts` lookups there        | the page waited for the browser's font answers              |
| `present` large, `renderer` idle                         | the frame waited in the GPU process: `gpu`, `viz`, `frames` |
| `present` large, `gpu` `off-cpu`, `shaders` `cpu` large  | the GPU process compiling shaders for a first use           |

## Diff verdicts

Each row of a diff compares the values of every run before with every run after, by a Mann-Whitney
U test. A change with p < 0.05 is called less or more (faster or slower for spans). Anything else
is `unclear`: noise between launches could explain it. `too few` means the sides are too small for
the test to reach p < 0.05 at all. With 4 runs a side the test calls a change only when every run
after beats every run before. With 5 a side, the default, it allows two runs out of order.

## Source lines

Profilers report positions in the bundle that ran. perfq maps them back to source lines through the
bundle's source map. Rebuilding replaces that map, and the old runs' positions then point at the
wrong lines. dodocode's recorder saves each run's maps beside it (`<run>.maps.json`, `maps/`), so
old runs keep their lines. For a run without saved maps, perfq maps through the map beside the
bundle (`<file>.map`), unless the bundle was rebuilt after the run. In that case it shows bundle
positions and prints a `maps stale` field naming those bundles.

## Developing

```sh
cargo test --manifest-path tools/perfq/Cargo.toml
```
