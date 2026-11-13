// The commands that read one set of runs: summary, spans, top and tasks. And what ran in some
// stretches of a run, as fields, which slow and tasks print for each moment they list.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write;

use crate::Opts;
use crate::fmt::{Table, arg, at, cell_ms, field, fields, items, ms, pct, seconds};
use crate::model::{FuncId, FuncKind, Funcs, Run, Task, Thread, WORKS, Work};
use crate::query::{self, Filter, Need};
use crate::stats::{median, percentile};

const LONG_TASK_US: f64 = 50_000.0;
/// The threads a moment's fields show, besides the one it is about: the page, Electron's main
/// process, and the GPU process's main thread and the one that puts frames together for the screen.
const SHOWN: [&str; 4] = ["renderer", "browser", "gpu", "viz"];

pub fn summary(runs: &[Run], o: &Opts, funcs: &Funcs) -> String {
    let mut out = String::new();
    let inputs = o.input_args();
    let length = median(&runs.iter().map(|r| r.end - r.start).collect::<Vec<_>>());
    let mut head = vec![field("runs", runs.len().to_string())];
    if runs.len() == 1 {
        head.push(field("run", runs[0].name.clone()));
        head.push(field("length", seconds(length)));
    } else {
        head.push(field("length-p50", seconds(length)));
    }
    if runs.iter().any(|r| !r.font_lookups.is_empty()) {
        let per_run = |f: &dyn Fn(&Run) -> f64| median(&runs.iter().map(f).collect::<Vec<_>>());
        let lookups = per_run(&|r| r.font_lookups.len() as f64);
        let answering = per_run(&|r| r.font_lookups.iter().map(|f| f.1 - f.0).sum());
        let parts = [
            ("lookups", format!("{lookups:.0}")),
            ("answering", ms(answering)),
        ];
        head.push(field("fonts", items(&parts)));
    }
    if runs.iter().any(|r| !r.shader_tasks.is_empty()) {
        let per_run = |f: &dyn Fn(&Run) -> f64| median(&runs.iter().map(f).collect::<Vec<_>>());
        let tasks = per_run(&|r| r.shader_tasks.len() as f64);
        let cpu = per_run(&|r| r.shader_tasks.iter().map(|s| s.cpu).sum());
        let parts = [("tasks", format!("{tasks:.0}")), ("cpu", ms(cpu))];
        head.push(field("shaders", items(&parts)));
    }
    out += &fields("", &head);

    // Each thread's busy time, by kind of work.
    let labels = query::labels(runs);
    let mut rows = Vec::new();
    let mut used = [false; WORKS.len()];
    for label in &labels {
        let threads: Vec<(&Run, &Thread)> = runs
            .iter()
            .filter_map(|r| r.thread(label).map(|t| (r, t)))
            .collect();
        let works: Vec<HashMap<Work, f64>> = threads
            .iter()
            .map(|(_, t)| query::work_in(t, &None))
            .collect();
        let busy = median(&works.iter().map(|m| m.values().sum()).collect::<Vec<f64>>());
        let off: Vec<f64> = threads
            .iter()
            .filter_map(|(r, t)| t.busy_between(r.start, r.end).off_cpu)
            .collect();
        let off_cpu = (!off.is_empty()).then(|| median(&off));
        let by_work: Vec<f64> = WORKS
            .iter()
            .map(|w| {
                median(
                    &works
                        .iter()
                        .map(|m| m.get(w).copied().unwrap_or(0.0))
                        .collect::<Vec<_>>(),
                )
            })
            .collect();
        for (i, v) in by_work.iter().enumerate() {
            used[i] |= *v >= 500.0;
        }
        let from = if threads.iter().all(|(_, t)| t.tasks.is_empty()) {
            "samples"
        } else {
            "trace"
        };
        rows.push((label.clone(), from, busy, off_cpu, by_work));
    }
    let mut columns = vec![
        ("thread", false),
        ("from", false),
        ("busy", true),
        ("of run", true),
        ("off-cpu", true),
    ];
    for (i, w) in WORKS.iter().enumerate() {
        if used[i] {
            columns.push((w.label(), true));
        }
    }
    let mut table = Table::new(&columns);
    for (label, from, busy, off_cpu, by_work) in rows {
        let mut cells = vec![
            label,
            from.to_string(),
            ms(busy),
            pct(busy, length),
            off_cpu.map_or("-".to_string(), cell_ms),
        ];
        for (i, v) in by_work.iter().enumerate() {
            if used[i] {
                cells.push(cell_ms(*v));
            }
        }
        table.row(cells);
    }
    out += "\n## threads\n";
    out += &table.render();

    // Spans.
    let groups = span_groups(runs, None);
    out += "\n## spans\n";
    if groups.is_empty() {
        out += "none\n";
    } else {
        out += &span_table(&groups, 8, runs.len());
        if groups.len() > 8 {
            out += &fields("", &[field("more", format!("{} names", groups.len() - 8))]);
        }
    }

    // Long tasks.
    let mut long_on = Vec::new();
    let mut columns = vec![
        ("thread", false),
        ("n", true),
        ("longest", true),
        ("at", true),
    ];
    if runs.len() > 1 {
        columns.push(("run", false));
    }
    let mut long_table = Table::new(&columns);
    for label in &labels {
        let mut long: Vec<(&Run, &Task)> = runs
            .iter()
            .filter_map(|r| r.thread(label).map(|t| (r, t)))
            .flat_map(|(r, t)| {
                t.tasks
                    .iter()
                    .filter(|k| k.dur() >= LONG_TASK_US)
                    .map(move |k| (r, k))
            })
            .collect();
        if long.is_empty() {
            continue;
        }
        long.sort_by(|a, b| b.1.dur().total_cmp(&a.1.dur()));
        let (run, task) = long[0];
        let mut cells = vec![
            label.clone(),
            long.len().to_string(),
            ms(task.dur()),
            at(task.start - run.start),
        ];
        if runs.len() > 1 {
            cells.push(run.name.clone());
        }
        long_table.row(cells);
        long_on.push(label.clone());
    }
    if runs
        .iter()
        .any(|r| r.threads.iter().any(|t| !t.tasks.is_empty()))
    {
        let _ = writeln!(out, "\n## tasks over {}", ms(LONG_TASK_US));
        if long_on.is_empty() {
            out += "none\n";
        } else {
            out += &long_table.render();
        }
    }

    // Where the time went.
    let thread = query::pick_thread(runs, o.thread.as_deref(), Need::Samples).ok();
    if let Some(thread) = &thread {
        let w = query::weigh(runs, thread, &Filter::default(), funcs);
        let per = w.runs.max(1) as f64;
        let mut hot: Vec<(FuncId, f64)> = w.self_us.iter().map(|(&f, &t)| (f, t)).collect();
        hot.sort_by(|a, b| b.1.total_cmp(&a.1));
        if !hot.is_empty() {
            let _ = writeln!(out, "\n## self time: {thread}");
            let mut table = Table::new(&[("self", true), ("self%", true), ("function", false)]);
            for (f, t) in hot.iter().take(5) {
                table.row(vec![
                    ms(t / per),
                    pct(*t, w.busy),
                    query::short_name(funcs, *f),
                ]);
            }
            out += &table.render();
        }
    }

    let mut next = Vec::new();
    if runs.iter().any(|r| !r.interactions.is_empty()) {
        next.push((
            format!("perfq slow {inputs}"),
            "slow interactions, stutters",
        ));
    }
    if let Some(thread) = &thread {
        let flag = thread_flag(thread);
        next.push((format!("perfq top {inputs}{flag}"), "functions"));
    }
    if !long_on.is_empty() {
        let flag = thread_flag(&long_on[0]);
        next.push((format!("perfq tasks {inputs}{flag}"), "long tasks"));
    }
    if groups.len() > 8 {
        next.push((format!("perfq spans {inputs}"), "every span name"));
    }
    let slowest = |prefix: &str| {
        groups
            .iter()
            .filter(|g| g.0.starts_with(prefix))
            .max_by(|a, b| percentile(&a.1, 50.0).total_cmp(&percentile(&b.1, 50.0)))
            .map(|g| g.0.clone())
    };
    if let Some(span) = slowest("") {
        next.push((
            format!("perfq top {inputs} --during {}", arg(&span)),
            "slowest span: functions",
        ));
    }
    if labels.iter().any(|l| l == "server")
        && let Some(call) = slowest("call:")
    {
        next.push((
            format!("perfq top {inputs} --thread server --during {}", arg(&call)),
            "slowest call: server functions",
        ));
    }
    out += &hints(&next);
    out
}

pub fn spans(runs: &[Run], o: &Opts) -> String {
    let mut out = String::new();
    let groups = span_groups(runs, o.matching.as_deref());
    let count: usize = groups.iter().map(|g| g.1.len()).sum();
    let mut head = vec![field("runs", runs.len().to_string())];
    if let Some(m) = &o.matching {
        head.push(field("match", m.clone()));
    }
    head.push(field("spans", count.to_string()));
    head.push(field("names", groups.len().to_string()));
    out += &fields("", &head);
    if groups.is_empty() {
        return out;
    }
    let limit = o.limit.unwrap_or(30);
    out.push('\n');
    out += &span_table(&groups, limit, runs.len());
    if groups.len() > limit {
        out += &more(groups.len() - limit, groups.len());
    }
    let slowest = groups
        .iter()
        .max_by(|a, b| percentile(&a.1, 50.0).total_cmp(&percentile(&b.1, 50.0)));
    if let Some((name, _)) = slowest {
        let inputs = o.input_args();
        out += &hints(&[(
            format!("perfq top {inputs} --during {}", arg(name)),
            "slowest span: functions",
        )]);
    }
    out
}

/// Spans by name, each with its durations sorted; the names with the most time in all first.
fn span_groups(runs: &[Run], matching: Option<&str>) -> Vec<(String, Vec<f64>)> {
    let mut by_name: BTreeMap<&str, Vec<f64>> = BTreeMap::new();
    for run in runs {
        for s in &run.spans {
            if matching.is_none_or(|m| s.name.contains(m)) {
                by_name.entry(&s.name).or_default().push(s.dur());
            }
        }
    }
    let mut out: Vec<(String, Vec<f64>)> = by_name
        .into_iter()
        .map(|(name, mut durs)| {
            durs.sort_by(f64::total_cmp);
            (name.to_string(), durs)
        })
        .collect();
    out.sort_by(|a, b| b.1.iter().sum::<f64>().total_cmp(&a.1.iter().sum::<f64>()));
    out
}

fn span_table(groups: &[(String, Vec<f64>)], limit: usize, runs: usize) -> String {
    let total = if runs == 1 { "total" } else { "total/run" };
    let mut table = Table::new(&[
        ("span", false),
        ("n", true),
        ("p50", true),
        ("p95", true),
        ("max", true),
        (total, true),
    ]);
    for (name, durs) in groups.iter().take(limit) {
        table.row(vec![
            name.clone(),
            durs.len().to_string(),
            ms(percentile(durs, 50.0)),
            ms(percentile(durs, 95.0)),
            ms(durs.last().copied().unwrap_or(0.0)),
            ms(durs.iter().sum::<f64>() / runs as f64),
        ]);
    }
    table.render()
}

pub fn top(runs: &[Run], o: &Opts, funcs: &Funcs) -> Result<String, String> {
    let thread = query::pick_thread(runs, o.thread.as_deref(), Need::Samples)?;
    o.filter.check(runs)?;
    let w = query::weigh(runs, &thread, &o.filter, funcs);
    let per = w.runs.max(1) as f64;
    let pattern = o.matching.as_ref().map(|m| m.to_lowercase());
    let self_of = |f: &FuncId| w.self_us.get(f).copied().unwrap_or(0.0);
    let total_of = |f: &FuncId| w.total_us.get(f).copied().unwrap_or(0.0);
    let mut ids: Vec<FuncId> = w
        .total_us
        .keys()
        .copied()
        .filter(|&f| {
            pattern.as_ref().is_none_or(|p| {
                let func = funcs.get(f);
                func.name.to_lowercase().contains(p) || func.loc.to_lowercase().contains(p)
            })
        })
        .collect();
    if o.by_total {
        ids.sort_by(|a, b| total_of(b).total_cmp(&total_of(a)));
    } else {
        ids.sort_by(|a, b| {
            self_of(b)
                .total_cmp(&self_of(a))
                .then(total_of(b).total_cmp(&total_of(a)))
        });
    }

    let mut out = String::new();
    let mut head = vec![
        field("thread", thread.clone()),
        field("runs", w.runs.to_string()),
    ];
    head.extend(o.filter.fields(runs));
    head.push(field("busy", ms(w.busy / per)));
    if let Some(m) = &o.matching {
        let matched: f64 = ids.iter().map(self_of).sum();
        head.push(field("match", m.clone()));
        head.push(field("functions", ids.len().to_string()));
        head.push(field(
            "self",
            format!("{} {}", ms(matched / per), pct(matched, w.busy)),
        ));
    }
    out += &fields("", &head);
    if w.busy <= 0.0 {
        return Ok(out);
    }

    let limit = o.limit.unwrap_or(20);
    let mut table = Table::new(&[
        ("self", true),
        ("self%", true),
        ("total", true),
        ("total%", true),
        ("function", false),
        ("location", false),
    ]);
    for f in ids.iter().take(limit) {
        let func = funcs.get(*f);
        table.row(vec![
            cell_ms(self_of(f) / per),
            pct(self_of(f), w.busy),
            ms(total_of(f) / per),
            pct(total_of(f), w.busy),
            func.name.clone(),
            func.loc.clone(),
        ]);
    }
    if ids.len() > limit {
        let rest: f64 = ids[limit..].iter().map(self_of).sum();
        let more = format!("({} more functions)", ids.len() - limit);
        table.row(vec![
            cell_ms(rest / per),
            pct(rest, w.busy),
            String::new(),
            String::new(),
            more,
            String::new(),
        ]);
    }
    out.push('\n');
    out += &table.render();

    let js = |f: &&FuncId| funcs.get(**f).kind == FuncKind::Js;
    let scope = scope_flags(o, &thread);
    let inputs = o.input_args();
    let mut next = Vec::new();
    if let Some(&f) = ids
        .iter()
        .filter(js)
        .max_by(|a, b| self_of(a).total_cmp(&self_of(b)))
    {
        next.push((
            format!(
                "perfq tree {inputs}{scope} --callers {}",
                arg(&query::func_arg(funcs, f))
            ),
            "most self time: callers",
        ));
    }
    if let Some(&f) = ids
        .iter()
        .filter(js)
        .max_by(|a, b| total_of(a).total_cmp(&total_of(b)))
    {
        next.push((
            format!(
                "perfq tree {inputs}{scope} --root {}",
                arg(&query::func_arg(funcs, f))
            ),
            "most total time: callees",
        ));
    }
    out += &hints(&next);
    Ok(out)
}

pub fn tasks(runs: &[Run], o: &Opts, funcs: &Funcs) -> Result<String, String> {
    let thread = query::pick_thread(runs, o.thread.as_deref(), Need::Tasks)?;
    o.filter.check(runs)?;
    let min = o.min.unwrap_or(50.0) * 1000.0;
    let mut long: Vec<(&Run, &Task)> = Vec::new();
    let mut count = 0;
    let mut longest: f64 = 0.0;
    for run in runs {
        let Some(t) = run.thread(&thread) else {
            continue;
        };
        let windows = o.filter.windows(run);
        for task in &t.tasks {
            if let Some(list) = &windows
                && !list.iter().any(|w| w.0 < task.end && w.1 > task.start)
            {
                continue;
            }
            count += 1;
            longest = longest.max(task.dur());
            if task.dur() >= min {
                long.push((run, task));
            }
        }
    }
    long.sort_by(|a, b| b.1.dur().total_cmp(&a.1.dur()));
    let mut out = String::new();
    let mut head = vec![
        field("thread", thread.clone()),
        field("runs", runs.len().to_string()),
    ];
    head.extend(o.filter.fields(runs));
    head.extend([
        field("tasks", count.to_string()),
        field("min", ms(min)),
        field("long", long.len().to_string()),
        field("longest", ms(longest)),
    ]);
    out += &fields("", &head);
    if long.is_empty() {
        return Ok(out);
    }

    let _ = writeln!(out, "\n## tasks over {}", ms(min));
    let limit = o.limit.unwrap_or(10);
    for (rank, (run, task)) in long.iter().take(limit).enumerate() {
        let _ = writeln!(
            out,
            "\n### {}  {}  at {}{}",
            rank + 1,
            ms(task.dur()),
            at(task.start - run.start),
            run_place(runs, run)
        );
        out += &fields("", &details(run, &thread, &[(task.start, task.end)], funcs));
    }
    if long.len() > limit {
        out.push('\n');
        out += &more(long.len() - limit, long.len());
    }
    let (run, task) = long[0];
    out += &hints(&look(run, task.start, task.end, &thread, "longest task"));
    Ok(out)
}

/// What ran in some stretches of a run, as fields: each thread's time there, the font lookups and
/// frames in them, the spans they overlap, and the functions that ran. `focus` is the thread the
/// stretches are about: its time is split by kind of work, and the functions are its own.
pub fn details(
    run: &Run,
    focus: &str,
    windows: &[(f64, f64)],
    funcs: &Funcs,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let length: f64 = windows.iter().map(|w| w.1 - w.0).sum();
    let overlaps = |a: f64, b: f64| windows.iter().any(|w| a < w.1 && b > w.0);

    let mut labels: Vec<&str> = SHOWN.to_vec();
    if !labels.contains(&focus) {
        labels.insert(0, focus);
    }
    for label in labels {
        let Some(t) = run.thread(label) else {
            continue;
        };
        let mut works: HashMap<Work, f64> = HashMap::new();
        for &(a, b) in windows {
            for (w, v) in t.work_between(a, b) {
                *works.entry(w).or_insert(0.0) += v;
            }
        }
        let mut busy: f64 = works.values().sum();
        let mut off_cpu = None;
        if !t.tasks.is_empty() {
            busy = 0.0;
            for &(a, b) in windows {
                let here = t.busy_between(a, b);
                busy += here.busy;
                if let Some(off) = here.off_cpu {
                    *off_cpu.get_or_insert(0.0) += off;
                }
            }
        }
        let mut parts = vec![("busy", ms(busy))];
        if let Some(off) = off_cpu {
            parts.push(("off-cpu", ms(off)));
        }
        parts.push(("idle", ms((length - busy).max(0.0))));
        if label == focus {
            let mut works: Vec<(Work, f64)> =
                works.into_iter().filter(|(_, v)| *v >= 100.0).collect();
            works.sort_by(|a, b| b.1.total_cmp(&a.1));
            parts.extend(works.iter().map(|(w, v)| (w.label(), ms(*v))));
        }
        out.push(field(label, items(&parts)));
    }

    let lookups: Vec<f64> = run
        .font_lookups
        .iter()
        .filter(|f| overlaps(f.0, f.1))
        .map(|f| f.1 - f.0)
        .collect();
    if !lookups.is_empty() {
        let parts = [
            ("lookups", lookups.len().to_string()),
            ("answering", ms(lookups.iter().sum())),
        ];
        out.push(field("fonts", items(&parts)));
    }

    let shaders: Vec<f64> = run
        .shader_tasks
        .iter()
        .filter(|s| overlaps(s.start, s.end))
        .map(|s| s.cpu)
        .collect();
    if !shaders.is_empty() {
        let parts = [
            ("tasks", shaders.len().to_string()),
            ("cpu", ms(shaders.iter().sum())),
        ];
        out.push(field("shaders", items(&parts)));
    }

    let frames: Vec<_> = run
        .frames
        .iter()
        .filter(|f| windows.iter().any(|w| f.start >= w.0 && f.start < w.1))
        .collect();
    if !frames.is_empty() {
        let mut shown: Vec<f64> = frames
            .iter()
            .filter(|f| f.shown)
            .map(|f| f.end - f.start)
            .collect();
        shown.sort_by(f64::total_cmp);
        let mut parts = vec![
            ("shown", shown.len().to_string()),
            ("dropped", (frames.len() - shown.len()).to_string()),
        ];
        if let Some(&max) = shown.last() {
            parts.push(("latency-p50", ms(percentile(&shown, 50.0))));
            parts.push(("latency-max", ms(max)));
        }
        out.push(field("frames", items(&parts)));
    }

    let mut spans: Vec<&str> = Vec::new();
    for s in run.spans.iter().filter(|s| overlaps(s.start, s.end)) {
        if !spans.contains(&s.name.as_str()) {
            spans.push(&s.name);
        }
    }
    if !spans.is_empty() {
        out.push(field("spans", spans.join(", ")));
    }

    let top = |weights: HashMap<FuncId, f64>, n: usize, loc: bool| {
        let mut hot: Vec<(FuncId, f64)> = weights.into_iter().filter(|w| w.1 >= 100.0).collect();
        hot.sort_by(|a, b| b.1.total_cmp(&a.1));
        hot.iter()
            .take(n)
            .map(|&(f, t)| {
                let func = funcs.get(f);
                if loc && !query::nameless(func) {
                    format!("{} {} {}", func.name, func.loc, ms(t))
                } else {
                    format!("{} {}", query::short_name(funcs, f), ms(t))
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    };
    let windows = Some(windows.to_vec());
    if let Some(own) = query::weigh_own(run, focus, &windows, funcs) {
        let own = top(own, 3, true);
        if !own.is_empty() {
            out.push(field("our code", own));
        }
    }
    if let Some(w) = query::weigh_run(run, focus, &windows, funcs) {
        let hot = top(w.self_us, 5, false);
        if !hot.is_empty() {
            out.push(field("self time", hot));
        }
    }
    out
}

/// `  run <name>`, when several runs are read and a moment needs to say which it is from.
pub fn run_place(runs: &[Run], run: &Run) -> String {
    if runs.len() > 1 {
        format!("  run {}", run.name)
    } else {
        String::new()
    }
}

/// The rows a list left out, and the option that shows them.
pub fn more(hidden: usize, all: usize) -> String {
    fields("", &[field("more", format!("{hidden}, --limit {all}"))])
}

/// The commands that look into a stretch of a run, function by function and as a call tree.
pub fn look(run: &Run, start: f64, end: f64, thread: &str, what: &str) -> Vec<(String, String)> {
    let from = ((start - run.start) / 1000.0).floor() / 1000.0;
    let to = ((end - run.start) / 1000.0).ceil() / 1000.0;
    let source = arg(&run.source);
    let flag = thread_flag(thread);
    vec![
        (
            format!("perfq top {source}{flag} --window {from:.3}-{to:.3}"),
            format!("{what}: functions"),
        ),
        (
            format!("perfq tree {source}{flag} --window {from:.3}-{to:.3}"),
            format!("{what}: call tree"),
        ),
    ]
}

pub fn thread_flag(thread: &str) -> String {
    if thread == "renderer" {
        String::new()
    } else {
        format!(" --thread {}", arg(thread))
    }
}

/// The options that chose a query's thread and time, to pass on to the next one.
pub fn scope_flags(o: &Opts, thread: &str) -> String {
    let mut out = thread_flag(thread);
    if let Some(during) = &o.filter.during {
        out += &format!(" --during {}", arg(during));
    }
    if let Some((from, to)) = o.filter.window {
        out += &format!(" --window {from}-{to}");
    }
    out
}

/// Commands to run next, each with what it shows.
pub fn hints<T: AsRef<str>>(next: &[(String, T)]) -> String {
    if next.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nnext:\n");
    for (command, what) in next {
        let _ = writeln!(out, "  {command}  # {}", what.as_ref());
    }
    out
}
