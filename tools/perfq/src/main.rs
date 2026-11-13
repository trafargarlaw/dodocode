// perfq answers questions about an app's performance from its traces, in a few dozen lines each, so
// an agent (or a person) can read the answer whole instead of paging through a trace's raw events.
// See README.md.

mod diff;
mod fmt;
mod load;
mod model;
mod query;
mod report;
mod slow;
mod stats;
mod symbols;
mod tree;

use query::Filter;
use symbols::Symbols;

const HELP: &str = "\
perfq: what an app's time went to, read from its performance traces.

usage: perfq <command> <runs...> [options]

runs
  A Chrome trace (*.trace.json, or any .json the DevTools Performance panel saves), with the
  server's CPU profile beside it (<run>.server.cpuprofile), or a CPU profile alone (*.cpuprofile).
  Files, or folders of them. Several runs are read together, and times are then per run: the
  median, or for functions the mean.

commands
  summary   each thread's time, the spans, tasks over 50ms, the functions with most self time
  slow      clicks and key presses over --min (100ms), and stutters, with what ran in each
  spans     performance.measure() spans by name
  top       functions by self time, or by total time with --sort total
  tree      the call tree: from the top, from a function (--root), or up to its callers (--callers)
  tasks     a thread's tasks over --min (50ms), with what ran in each
  diff      <before> <after>: spans, busy time and functions, each change with a verdict

options
  --thread <name>       renderer (the default), browser, gpu, viz, server
  --during <span>       only the time inside spans of that name; end it with * for a prefix (call:*)
  --window <a-b>        only the time from a to b seconds into each run (1.20-1.35)
  --limit <n>           rows or items to show
  --sort total          top: by total time, not self time
  --match <text>        top: only functions with it in their name or file; spans: in their name
  --root <function>     tree: start at this function (a name, or part of a name or file:line)
  --callers <function>  tree: the paths that call this function
  --depth <n>           tree: how deep to go (24)
  --min <n>             tree: leave out calls under n% of the time (1); tasks: under n ms (50);
                        slow: the ms a click or key press may take (100)
  --help, -h            this text

output
  `key  value` is a field; a value made of parts is `name value, name value`. Tables have a
  header row, and `-` in a cell is nothing. `## name` starts a section, `### rank  ...` an item
  in it, ranked worst first. `next:` lists commands to run next, each with `# what it shows`.
  Durations are wall time. `at` is seconds into the run. p50, p95: percentiles.

threads
  renderer  the page's main thread: script, style, layout, paint
  browser   Electron's main process: input, windows, and the page's requests (fonts, IPC)
  gpu       the GPU process's main thread: runs the GPU commands that draw frames
  viz       the GPU process's compositor thread: puts frames together for the screen
  server    the server's CPU profile
  gpu and viz show only when the trace has the GPU process: one recorded by
  apps/desktop/src/main/tracing.ts has it.

fields and columns
  busy            time in the thread's tasks (from trace), or in its CPU samples (from samples)
  off-cpu         the part of busy the thread was off the CPU: waiting on a lock, a reply, the
                  disk, or Windows giving it none. renderer and browser both mostly off-cpu at
                  once: the machine paused the app.
  idle            the stretch's length less busy
  of run          busy as a share of the run's length
  script style layout paint gc parse other
                  busy by kind of work; other: in a task, none of the rest
  self, total     time in the function itself; with what it calls. self%, total%: of busy
  phases          an interaction, from input to its frame on screen:
                    waiting   until its handlers started: the thread was busy with other work
                    handlers  its event handlers
                    render    handlers to the frame handed to the compositor: style, layout,
                              paint, commit
                    present   that frame to the screen: the GPU process drawing it, and the
                              wait for the screen's next refresh
                    drawing   render and present together, when the trace does not split them
  fonts           lookups: fonts the page asked the browser for; answering: the browser's time
                  answering them. The page waits for each answer, often in the middle of a layout.
  shaders         tasks: the GPU process's shader work on its ANGLE threads: compiling shaders, or
                  loading compiled ones from Chrome's disk cache; cpu: their CPU time. A frame
                  that needs a shader waits for it, and gpu shows that wait as off-cpu. Large on a
                  first use that the disk cache does not hold yet.
  frames          the page's frames that started in the stretch. shown: reached the screen;
                  dropped: replaced before they did; latency: start to screen, of the shown ones
  long frames     frames of 50ms or more
  stutter         long frames after launch, outside slow interactions, less than 1s apart
  spans           the spans that overlap the stretch
  our code        the app's own functions (outside node_modules) by self time, with location
  self time       the thread's functions by self time
  slow            slow actions: n: times done; slow: times over the budget
  untimed         slow: clicks and key presses the app marked that Chrome did not time: the
                  window drew no frames then (covered or minimised), or the press became no
                  click (a drag started, or it was cancelled). Left out of interactions and
                  slow; `tasks --window` shows their work.
  verdict         diff: faster, slower, less, more: a change at p<0.05; unclear: p>=0.05;
                  too few: too few values a side to reach p<0.05; only before, only after
  maps stale      bundles rebuilt since the run was recorded: their functions show bundle
                  positions, not source lines
  maps unreadable a run's <run>.maps.json, which could not be read
  more            rows left out, and how to show them
  cut             tree: calls deeper than --depth, left out

Locations are source lines when the run saved its build's source maps (<run>.maps.json, beside
the run), or when the bundle has a map beside it (<file>.map) and was not rebuilt since the run.

examples
  perfq summary traces/
  perfq slow traces/session
  perfq top traces/ --during startup
  perfq tree traces/ --callers commitRoot
  perfq top traces/ --thread server --during 'call:*'
  perfq diff traces/before traces/after
";

#[derive(Default)]
pub struct Opts {
    pub inputs: Vec<String>,
    pub thread: Option<String>,
    pub filter: Filter,
    pub limit: Option<usize>,
    pub by_total: bool,
    pub matching: Option<String>,
    pub root: Option<String>,
    pub callers: Option<String>,
    pub depth: Option<usize>,
    pub min: Option<f64>,
}

impl Opts {
    fn parse(args: &[String]) -> Result<Opts, String> {
        let mut o = Opts::default();
        let mut i = 0;
        while i < args.len() {
            let Some(flag) = args[i].strip_prefix("--") else {
                o.inputs.push(args[i].clone());
                i += 1;
                continue;
            };
            let (flag, inline) = match flag.split_once('=') {
                Some((f, v)) => (f, Some(v.to_string())),
                None => (flag, None),
            };
            let value = match inline {
                Some(v) => v,
                None => {
                    i += 1;
                    args.get(i)
                        .cloned()
                        .ok_or_else(|| format!("--{flag} needs a value"))?
                }
            };
            match flag {
                "thread" => o.thread = Some(value),
                "during" => o.filter.during = Some(value),
                "window" => o.filter.window = Some(parse_window(&value)?),
                "limit" => o.limit = Some(number(flag, &value)?),
                "sort" => {
                    o.by_total = match value.as_str() {
                        "self" => false,
                        "total" => true,
                        _ => return Err(format!("--sort takes self or total, not {value}")),
                    }
                }
                "match" => o.matching = Some(value),
                "root" => o.root = Some(value),
                "callers" => o.callers = Some(value),
                "depth" => o.depth = Some(number(flag, &value)?),
                "min" => o.min = Some(number(flag, &value)?),
                _ => return Err(format!("no option --{flag}: perfq help lists them")),
            }
            i += 1;
        }
        Ok(o)
    }

    /// The inputs, as a command line takes them again.
    pub fn input_args(&self) -> String {
        self.inputs
            .iter()
            .map(|s| fmt::arg(s))
            .collect::<Vec<_>>()
            .join(" ")
    }
}

fn number<T: std::str::FromStr>(flag: &str, value: &str) -> Result<T, String> {
    value
        .parse()
        .map_err(|_| format!("--{flag} takes a number, not {value}"))
}

fn parse_window(value: &str) -> Result<(f64, f64), String> {
    let wrong = || format!("--window takes seconds into the run as a-b (1.20-1.35), not {value}");
    let (a, b) = value.split_once('-').ok_or_else(wrong)?;
    let seconds = |s: &str| {
        s.trim()
            .trim_end_matches('s')
            .parse::<f64>()
            .map_err(|_| wrong())
    };
    let (a, b) = (seconds(a)?, seconds(b)?);
    if b <= a {
        return Err(wrong());
    }
    Ok((a, b))
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    match run(&args) {
        Ok(out) => print!("{out}"),
        Err(e) => {
            eprintln!("perfq: {e}");
            std::process::exit(1);
        }
    }
}

fn run(args: &[String]) -> Result<String, String> {
    let Some(command) = args.first() else {
        return Ok(HELP.to_string());
    };
    if command == "help" || args.iter().any(|a| a == "--help" || a == "-h") {
        return Ok(HELP.to_string());
    }
    let commands = ["summary", "slow", "spans", "top", "tree", "tasks", "diff"];
    if !commands.contains(&command.as_str()) {
        return Err(format!("no command {command}: perfq help lists them"));
    }
    let o = Opts::parse(&args[1..])?;
    if o.inputs.is_empty() {
        return Err(format!(
            "{command} needs runs to read: perfq {command} <trace, profile or folder>"
        ));
    }
    let mut symbols = Symbols::new();
    if command == "diff" {
        if o.inputs.len() != 2 {
            return Err(
                "diff takes two inputs, <before> <after>, each a run or a folder of runs"
                    .to_string(),
            );
        }
        let before = load::load(&o.inputs[..1], &mut symbols)?;
        let after = load::load(&o.inputs[1..], &mut symbols)?;
        return Ok(with_notes(
            &symbols.notes(),
            diff::diff(&before, &after, &o, &symbols.funcs)?,
        ));
    }
    let runs = load::load(&o.inputs, &mut symbols)?;
    let funcs = &symbols.funcs;
    let out = match command.as_str() {
        "summary" => report::summary(&runs, &o, funcs),
        "slow" => slow::slow(&runs, &o, funcs)?,
        "spans" => report::spans(&runs, &o),
        "top" => report::top(&runs, &o, funcs)?,
        "tree" => tree::tree(&runs, &o, funcs)?,
        "tasks" => report::tasks(&runs, &o, funcs)?,
        _ => unreachable!(),
    };
    Ok(with_notes(&symbols.notes(), out))
}

/// Notes go first: they say how far to trust what follows.
fn with_notes(notes: &[(String, String)], out: String) -> String {
    let mut text = fmt::fields("", notes);
    if !text.is_empty() {
        text.push('\n');
    }
    text + &out
}
