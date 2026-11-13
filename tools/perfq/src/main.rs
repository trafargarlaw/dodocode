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
perfq: what an app's time went to, read from its performance traces, a few lines at a time.

usage: perfq <command> <runs...> [options]

A run is a Chrome trace (*.trace.json, or any .json the DevTools Performance panel saves) with the
server's CPU profile beside it (<run>.server.cpuprofile), or a CPU profile alone (*.cpuprofile).
Name runs as files or as folders of them; several runs are read together.

commands:
  summary   each thread's busy time and what it went to, the spans, long tasks, the hottest functions
  slow      clicks and key presses that took over 100ms (--min) to show their result, by action,
            with what ran meanwhile; then the stretches of frames of 50ms or more that stutter
  spans     the performance.measure() spans by name: how many, p50, p95, max
  top       functions by CPU time: self (in the function) and total (with what it calls)
  tree      the call tree, from the top, from a function (--root) or up to its callers (--callers)
  tasks     the long tasks: when, what kind of work, which spans and functions ran in them
  diff      two sets of runs, <before> <after>, with a verdict on each change

options:
  --thread <name>       renderer (the default), browser (Electron's main process), server, ...
  --during <span>       only the time inside spans of that name; end it with * for a prefix (call:*)
  --window <a-b>        only the time from a to b seconds into each run (1.20-1.35)
  --limit <n>           rows to show
  --sort total          top: by total time, not self time
  --match <text>        top: only functions with it in their name or file; spans: in their name
  --root <function>     tree: start at this function (a name, or part of a name or file:line)
  --callers <function>  tree: the paths that call this function
  --depth <n>           tree: how deep to go (24)
  --min <n>             tree: leave out calls under n% of the time (1); tasks: under n ms (50);
                        slow: the ms a click or key press may take (100)

Times are per run, averaged, when several runs are read. Idle time is left out of CPU time.
Our code is the app's own functions, outside node_modules.
Locations are source lines when the run saved its build's source maps (<run>.maps.json, beside
the run), or when the bundle has a map beside it (<file>.map) and was not rebuilt since the run.

examples:
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
    if matches!(command.as_str(), "help" | "--help" | "-h") {
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
fn with_notes(notes: &[String], out: String) -> String {
    let mut text: String = notes.iter().map(|n| format!("note: {n}\n")).collect();
    if !text.is_empty() {
        text.push('\n');
    }
    text + &out
}
