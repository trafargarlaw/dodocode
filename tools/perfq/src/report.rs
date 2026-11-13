// The commands that read one set of runs: summary, spans, top and tasks.

use std::collections::{BTreeMap, HashMap};
use std::fmt::Write;

use crate::Opts;
use crate::fmt::{Table, arg, at, cell_ms, ms, pct, seconds};
use crate::model::{FuncId, FuncKind, Funcs, Run, Task, Thread, WORKS, Work};
use crate::query::{self, Filter, Need};
use crate::stats::{median, percentile};

const LONG_TASK_US: f64 = 50_000.0;

pub fn summary(runs: &[Run], o: &Opts, funcs: &Funcs) -> String {
    let mut out = String::new();
    let inputs = o.input_args();
    let length = median(&runs.iter().map(|r| r.end - r.start).collect::<Vec<_>>());
    if runs.len() == 1 {
        let _ = writeln!(out, "1 run, {}: {}", seconds(length), runs[0].name);
    } else {
        let _ = writeln!(
            out,
            "{} runs, {} each (median). Busy times are medians per run; spans count every instance.",
            runs.len(),
            seconds(length)
        );
    }

    // Each thread's busy time, by kind of work.
    let labels = query::labels(runs);
    let mut rows = Vec::new();
    let mut used = [false; WORKS.len()];
    let mut sampled_only = Vec::new();
    for label in &labels {
        let threads: Vec<_> = runs.iter().filter_map(|r| r.thread(label)).collect();
        let works: Vec<HashMap<Work, f64>> =
            threads.iter().map(|t| query::work_in(t, &None)).collect();
        let busy = median(&works.iter().map(|m| m.values().sum()).collect::<Vec<f64>>());
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
        if threads.iter().all(|t| t.tasks.is_empty()) && threads.iter().any(|t| t.profile.is_some())
        {
            sampled_only.push(label.clone());
        }
        rows.push((label.clone(), busy, by_work));
    }
    let mut columns = vec![("thread", false), ("busy", true), ("of run", true)];
    for (i, w) in WORKS.iter().enumerate() {
        if used[i] {
            columns.push((w.label(), true));
        }
    }
    let mut table = Table::new(&columns);
    for (label, busy, by_work) in rows {
        let mut cells = vec![label, ms(busy), pct(busy, length)];
        for (i, v) in by_work.iter().enumerate() {
            if used[i] {
                cells.push(cell_ms(*v));
            }
        }
        table.row(cells);
    }
    out.push('\n');
    out += &table.render();
    if !sampled_only.is_empty() {
        let _ = writeln!(
            out,
            "{}: from CPU samples alone, which tell script and gc apart from the rest, no more",
            sampled_only.join(", ")
        );
    }

    // Spans.
    let groups = span_groups(runs, None);
    out.push('\n');
    if groups.is_empty() {
        out += "no spans: the runs have no performance.measure() calls\n";
    } else {
        out += &span_table(&groups, 8, runs.len());
        if groups.len() > 8 {
            let _ = writeln!(
                out,
                "{} more span names: perfq spans {inputs}",
                groups.len() - 8
            );
        }
    }

    // Long tasks.
    out.push('\n');
    let mut long_on = Vec::new();
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
        let place = if runs.len() == 1 {
            format!("at {}", at(task.start - run.start))
        } else {
            format!("at {} in {}", at(task.start - run.start), run.name)
        };
        let count = if runs.len() == 1 {
            long.len().to_string()
        } else {
            format!("{} in {} runs", long.len(), runs.len())
        };
        let _ = writeln!(
            out,
            "{label}: {count} tasks of 50ms or more, the longest {} {place}",
            ms(task.dur())
        );
        long_on.push(label.clone());
    }
    if long_on.is_empty()
        && runs
            .iter()
            .any(|r| r.threads.iter().any(|t| !t.tasks.is_empty()))
    {
        out += "no task took 50ms or more\n";
    }

    // Where the time went.
    let thread = query::pick_thread(runs, o.thread.as_deref(), Need::Samples).ok();
    if let Some(thread) = &thread {
        let w = query::weigh(runs, thread, &Filter::default(), funcs);
        let mut hot: Vec<(FuncId, f64)> = w.self_us.iter().map(|(&f, &t)| (f, t)).collect();
        hot.sort_by(|a, b| b.1.total_cmp(&a.1));
        let items: Vec<String> = hot
            .iter()
            .take(5)
            .map(|(f, t)| format!("{} {}", query::short_name(funcs, *f), pct(*t, w.busy)))
            .collect();
        if !items.is_empty() {
            let _ = writeln!(out, "most self time on {thread}: {}", items.join(", "));
        }
    }

    let mut next = Vec::new();
    if let Some(thread) = &thread {
        let flag = thread_flag(thread);
        next.push((
            format!("perfq top {inputs}{flag}"),
            format!("where the {thread}'s time goes, function by function"),
        ));
    }
    if !long_on.is_empty() {
        let flag = thread_flag(&long_on[0]);
        next.push((
            format!("perfq tasks {inputs}{flag}"),
            "the long tasks, and what ran in them".to_string(),
        ));
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
            "what ran during the slowest span".to_string(),
        ));
    }
    if labels.iter().any(|l| l == "server")
        && let Some(call) = slowest("call:")
    {
        next.push((
            format!("perfq top {inputs} --thread server --during {}", arg(&call)),
            "the server's work while the slowest call waited on it".to_string(),
        ));
    }
    if runs.iter().any(|r| !r.interactions.is_empty()) {
        next.insert(
            0,
            (
                format!("perfq slow {inputs}"),
                "the clicks and key presses that took long, and the stutters".to_string(),
            ),
        );
    }
    out += &hints(&next);
    out
}

pub fn spans(runs: &[Run], o: &Opts) -> String {
    let mut out = String::new();
    let groups = span_groups(runs, o.matching.as_deref());
    let matching = o
        .matching
        .as_ref()
        .map_or(String::new(), |m| format!(" with {m} in their names"));
    let plural = if runs.len() == 1 { "" } else { "s" };
    if groups.is_empty() {
        let _ = writeln!(out, "no spans{matching} in {} run{plural}", runs.len());
        return out;
    }
    let count: usize = groups.iter().map(|g| g.1.len()).sum();
    let _ = writeln!(
        out,
        "{count} spans under {} names{matching}, in {} run{plural}; most time first",
        groups.len(),
        runs.len()
    );
    let limit = o.limit.unwrap_or(30);
    out += &span_table(&groups, limit, runs.len());
    if groups.len() > limit {
        let _ = writeln!(
            out,
            "{} more: --limit {}",
            groups.len() - limit,
            groups.len()
        );
    }
    let slowest = groups
        .iter()
        .max_by(|a, b| percentile(&a.1, 50.0).total_cmp(&percentile(&b.1, 50.0)));
    if let Some((name, _)) = slowest {
        let inputs = o.input_args();
        out += &hints(&[(
            format!("perfq top {inputs} --during {}", arg(name)),
            "what ran during the slowest one".to_string(),
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
    let mut out = String::new();
    let _ = writeln!(
        out,
        "{thread}: {} busy{}{}; idle time left out",
        ms(w.busy / per),
        o.filter.describe(runs),
        runs_note(w.runs)
    );
    if w.busy <= 0.0 {
        out += "nothing ran then\n";
        return Ok(out);
    }
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
        let more = format!("{} more functions", ids.len() - limit);
        table.row(vec![
            cell_ms(rest / per),
            pct(rest, w.busy),
            String::new(),
            String::new(),
            more,
            String::new(),
        ]);
    }
    out += &table.render();
    if let Some(m) = &o.matching {
        let matched: f64 = ids.iter().map(self_of).sum();
        let _ = writeln!(
            out,
            "{} functions have {m}: {} self time in all ({})",
            ids.len(),
            ms(matched / per),
            pct(matched, w.busy)
        );
    }

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
            format!("where {} is called from", funcs.get(f).name),
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
            format!("what {} spends its time on", funcs.get(f).name),
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
    let scope = o.filter.describe(runs);
    if long.is_empty() {
        let _ = writeln!(
            out,
            "{thread}: none of {count} tasks{scope} took {} or more; the longest took {}",
            ms(min),
            ms(longest)
        );
        return Ok(out);
    }
    let _ = writeln!(
        out,
        "{thread}: {} of {count} tasks{scope} took {} or more{}; longest first",
        long.len(),
        ms(min),
        runs_note(runs.len())
    );
    let limit = o.limit.unwrap_or(10);
    for (run, task) in long.iter().take(limit) {
        let t = run.thread(&thread).unwrap();
        let place = if runs.len() > 1 {
            format!(" in {}", run.name)
        } else {
            String::new()
        };
        let _ = writeln!(
            out,
            "\n{:>7}  at {}{place}: {}",
            ms(task.dur()),
            at(task.start - run.start),
            works_in(t, &[(task.start, task.end)])
        );
        out += &what_ran(run, &thread, &[(task.start, task.end)], funcs, "         ");
    }
    if long.len() > limit {
        let _ = writeln!(out, "\n{} more: --limit {}", long.len() - limit, long.len());
    }
    let (run, task) = long[0];
    let from = ((task.start - run.start) / 1000.0).floor() / 1000.0;
    let to = ((task.end - run.start) / 1000.0).ceil() / 1000.0;
    let source = arg(&run.source);
    let flag = thread_flag(&thread);
    out += &hints(&[
        (
            format!("perfq top {source}{flag} --window {from:.3}-{to:.3}"),
            "the longest task, function by function".to_string(),
        ),
        (
            format!("perfq tree {source}{flag} --window {from:.3}-{to:.3}"),
            "the longest task, as a call tree".to_string(),
        ),
    ]);
    Ok(out)
}

/// What a thread's time in some stretches went to, by kind of work: `script 120ms, layout 30ms`.
pub fn works_in(t: &Thread, windows: &[(f64, f64)]) -> String {
    let mut works: HashMap<Work, f64> = HashMap::new();
    for &(start, end) in windows {
        for (w, v) in t.work_between(start, end) {
            *works.entry(w).or_insert(0.0) += v;
        }
    }
    let mut works: Vec<(Work, f64)> = works.into_iter().filter(|(_, v)| *v >= 100.0).collect();
    works.sort_by(|a, b| b.1.total_cmp(&a.1));
    let works: Vec<String> = works
        .iter()
        .map(|(w, v)| format!("{} {}", w.label(), ms(*v)))
        .collect();
    works.join(", ")
}

/// What ran on a thread in some stretches of a run, a line each, after `pad`: the spans they
/// overlap, the app's own functions that led to the work, and the functions that took the most
/// time themselves.
pub fn what_ran(
    run: &Run,
    thread: &str,
    windows: &[(f64, f64)],
    funcs: &Funcs,
    pad: &str,
) -> String {
    let mut out = String::new();
    let mut spans: Vec<&str> = Vec::new();
    for s in run
        .spans
        .iter()
        .filter(|s| windows.iter().any(|w| s.start < w.1 && s.end > w.0))
    {
        if !spans.contains(&s.name.as_str()) {
            spans.push(&s.name);
        }
    }
    if !spans.is_empty() {
        let _ = writeln!(out, "{pad}in spans: {}", spans.join(", "));
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
    if let Some(own) = query::weigh_own(run, thread, &windows, funcs) {
        let own = top(own, 3, true);
        if !own.is_empty() {
            let _ = writeln!(out, "{pad}our code, with what it called: {own}");
        }
    }
    if let Some(w) = query::weigh_run(run, thread, &windows, funcs) {
        let hot = top(w.self_us, 5, false);
        if !hot.is_empty() {
            let _ = writeln!(out, "{pad}most self time: {hot}");
        }
    }
    out
}

/// `, 5 runs, per run`: how the numbers were added up.
pub fn runs_note(runs: usize) -> String {
    if runs > 1 {
        format!(", per run over {runs} runs")
    } else {
        String::new()
    }
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
pub fn hints(next: &[(String, String)]) -> String {
    if next.is_empty() {
        return String::new();
    }
    let mut out = String::from("\nnext:\n");
    for (command, what) in next {
        let _ = writeln!(out, "  {command}  # {what}");
    }
    out
}
