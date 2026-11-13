// What the commands share: the thread and stretch of time a query looks at, and the CPU samples'
// time added up by function or by call path.

use std::collections::HashMap;

use crate::fmt::{at, ms};
use crate::model::{Func, FuncId, FuncKind, Funcs, NO_PARENT, Profile, Run, Sample, Thread, Work};

/// The stretches of a run a query looks at, sorted and apart; None is all of it.
pub type Windows = Option<Vec<(f64, f64)>>;

#[derive(Default)]
pub struct Filter {
    /// Only inside spans of this name, or of this prefix when it ends with `*`.
    pub during: Option<String>,
    /// Only from .0 to .1 seconds into each run.
    pub window: Option<(f64, f64)>,
}

impl Filter {
    pub fn windows(&self, run: &Run) -> Windows {
        let mut out = None;
        if let Some(pattern) = &self.during {
            let spans = run.spans.iter().filter(|s| name_matches(pattern, &s.name));
            out = Some(spans.map(|s| (s.start, s.end)).collect::<Vec<_>>());
        }
        if let Some((from, to)) = self.window {
            let (a, b) = (run.start + from * 1e6, run.start + to * 1e6);
            out = Some(match out {
                None => vec![(a, b)],
                Some(list) => list
                    .into_iter()
                    .filter_map(|(x, y)| {
                        let (x, y) = (x.max(a), y.min(b));
                        (y > x).then_some((x, y))
                    })
                    .collect(),
            });
        }
        out.map(merge)
    }

    /// An error when --during names no span, listing the spans there are.
    pub fn check(&self, runs: &[Run]) -> Result<(), String> {
        let Some(pattern) = &self.during else {
            return Ok(());
        };
        if runs
            .iter()
            .any(|r| r.spans.iter().any(|s| name_matches(pattern, &s.name)))
        {
            return Ok(());
        }
        let mut names: Vec<&str> = runs
            .iter()
            .flat_map(|r| r.spans.iter().map(|s| s.name.as_str()))
            .collect();
        names.sort();
        names.dedup();
        if names.is_empty() {
            return Err(format!(
                "no span is named {pattern}: the runs have no spans"
            ));
        }
        let shown = names
            .iter()
            .take(12)
            .copied()
            .collect::<Vec<_>>()
            .join(", ");
        let more = if names.len() > 12 {
            format!(" and {} more", names.len() - 12)
        } else {
            String::new()
        };
        Err(format!(
            "no span is named {pattern} (end it with * for a prefix). Spans: {shown}{more}"
        ))
    }

    /// The scope, for a heading: ` during startup (1 span, 723ms)`.
    pub fn describe(&self, runs: &[Run]) -> String {
        let mut out = String::new();
        if let Some(pattern) = &self.during {
            let spans: Vec<f64> = runs
                .iter()
                .flat_map(|r| {
                    r.spans
                        .iter()
                        .filter(|s| name_matches(pattern, &s.name))
                        .map(|s| s.dur())
                })
                .collect();
            let plural = if spans.len() == 1 { "" } else { "s" };
            let total: f64 = spans.iter().sum();
            out += &format!(
                " during {pattern} ({} span{plural}, {} in all)",
                spans.len(),
                ms(total)
            );
        }
        if let Some((from, to)) = self.window {
            out += &format!(" from {} to {}", at(from * 1e6), at(to * 1e6));
        }
        out
    }
}

pub fn name_matches(pattern: &str, name: &str) -> bool {
    match pattern.strip_suffix('*') {
        Some(prefix) => name.starts_with(prefix),
        None => name == pattern,
    }
}

fn merge(mut list: Vec<(f64, f64)>) -> Vec<(f64, f64)> {
    list.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut out: Vec<(f64, f64)> = Vec::with_capacity(list.len());
    for (a, b) in list {
        match out.last_mut() {
            Some(last) if a <= last.1 => last.1 = last.1.max(b),
            _ => out.push((a, b)),
        }
    }
    out
}

pub fn inside(windows: &Windows, t: f64) -> bool {
    match windows {
        None => true,
        Some(list) => {
            let i = list.partition_point(|w| w.1 <= t);
            list.get(i).is_some_and(|w| w.0 <= t)
        }
    }
}

/// Which threads a command can read.
pub enum Need {
    Samples,
    Tasks,
}

impl Need {
    fn fits(&self, thread: &Thread) -> bool {
        match self {
            Need::Samples => thread.profile.is_some(),
            Need::Tasks => !thread.tasks.is_empty(),
        }
    }
}

/// The thread asked for, or the renderer, or the first one the runs have that fits.
pub fn pick_thread(runs: &[Run], wanted: Option<&str>, need: Need) -> Result<String, String> {
    let fits = |label: &str| {
        runs.iter()
            .any(|r| r.thread(label).is_some_and(|t| need.fits(t)))
    };
    let candidates: Vec<String> = labels(runs).into_iter().filter(|l| fits(l)).collect();
    if let Some(wanted) = wanted {
        if fits(wanted) {
            return Ok(wanted.to_string());
        }
        let what = match need {
            Need::Samples => "threads with CPU samples",
            Need::Tasks => "threads with tasks",
        };
        return Err(format!(
            "no thread {wanted} here. {what}: {}",
            list_or_none(&candidates)
        ));
    }
    if candidates.iter().any(|c| c == "renderer") {
        return Ok("renderer".to_string());
    }
    candidates.into_iter().next().ok_or_else(|| match need {
        Need::Samples => "the runs have no CPU samples".to_string(),
        Need::Tasks => {
            "the runs have no tasks: only a trace records them, not a CPU profile".to_string()
        }
    })
}

fn list_or_none(items: &[String]) -> String {
    if items.is_empty() {
        "none".to_string()
    } else {
        items.join(", ")
    }
}

/// Every thread label in the runs, in the order they first appear.
pub fn labels(runs: &[Run]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for run in runs {
        for t in &run.threads {
            if !out.contains(&t.label) {
                out.push(t.label.clone());
            }
        }
    }
    out
}

/// Time in each kind of work, in the windows.
pub fn work_in(thread: &Thread, windows: &Windows) -> HashMap<Work, f64> {
    let mut out = HashMap::new();
    match windows {
        None => {
            for s in &thread.slices {
                *out.entry(s.work).or_insert(0.0) += s.end - s.start;
            }
        }
        Some(list) => {
            for &(a, b) in list {
                for (work, t) in thread.work_between(a, b) {
                    *out.entry(work).or_insert(0.0) += t;
                }
            }
        }
    }
    out
}

pub fn is_idle(profile: &Profile, sample: &Sample, funcs: &Funcs) -> bool {
    let kind = funcs.get(profile.nodes[sample.node as usize].func).kind;
    matches!(kind, FuncKind::Idle | FuncKind::Root)
}

/// The functions on a sample's stack, outermost first.
pub fn stack(profile: &Profile, node: u32, funcs: &Funcs, out: &mut Vec<FuncId>) {
    out.clear();
    let mut n = node;
    while n != NO_PARENT {
        let node = &profile.nodes[n as usize];
        if funcs.get(node.func).kind != FuncKind::Root {
            out.push(node.func);
        }
        n = node.parent;
    }
    out.reverse();
}

/// CPU time by function: in the function itself (self) and with what it called (total).
#[derive(Default)]
pub struct Weights {
    pub self_us: HashMap<FuncId, f64>,
    pub total_us: HashMap<FuncId, f64>,
    /// Time not idle.
    pub busy: f64,
    /// Runs that had the thread.
    pub runs: usize,
}

impl Weights {
    pub fn add(&mut self, other: Weights) {
        for (f, t) in other.self_us {
            *self.self_us.entry(f).or_insert(0.0) += t;
        }
        for (f, t) in other.total_us {
            *self.total_us.entry(f).or_insert(0.0) += t;
        }
        self.busy += other.busy;
        self.runs += other.runs;
    }
}

pub fn weigh_run(run: &Run, thread: &str, windows: &Windows, funcs: &Funcs) -> Option<Weights> {
    let profile = run.thread(thread)?.profile.as_ref()?;
    let mut w = Weights {
        runs: 1,
        ..Weights::default()
    };
    let mut st = Vec::new();
    for s in &profile.samples {
        if !inside(windows, s.t) || is_idle(profile, s, funcs) {
            continue;
        }
        w.busy += s.w;
        *w.self_us
            .entry(profile.nodes[s.node as usize].func)
            .or_insert(0.0) += s.w;
        stack(profile, s.node, funcs, &mut st);
        // A function on the stack twice, by recursion, counts once.
        st.sort_unstable();
        st.dedup();
        for &f in &st {
            *w.total_us.entry(f).or_insert(0.0) += s.w;
        }
    }
    Some(w)
}

/// CPU time by the app's own function nearest each sample's leaf: the app's code that led to the
/// work, with what it called. Time with none of the app's code on the stack is left out.
pub fn weigh_own(
    run: &Run,
    thread: &str,
    windows: &Windows,
    funcs: &Funcs,
) -> Option<HashMap<FuncId, f64>> {
    let profile = run.thread(thread)?.profile.as_ref()?;
    let mut out = HashMap::new();
    for s in &profile.samples {
        if !inside(windows, s.t) {
            continue;
        }
        let mut n = s.node;
        while n != NO_PARENT {
            let node = &profile.nodes[n as usize];
            if funcs.get(node.func).own {
                *out.entry(node.func).or_insert(0.0) += s.w;
                break;
            }
            n = node.parent;
        }
    }
    Some(out)
}

pub fn weigh(runs: &[Run], thread: &str, filter: &Filter, funcs: &Funcs) -> Weights {
    let mut all = Weights::default();
    for run in runs {
        if let Some(w) = weigh_run(run, thread, &filter.windows(run), funcs) {
            all.add(w);
        }
    }
    all
}

/// The functions a `--root` or `--callers` pattern names: by exact name, else by a part of the
/// name or location (`app.tsx:42`).
pub fn match_funcs(funcs: &Funcs, pattern: &str) -> Result<Vec<bool>, String> {
    let mut hits = vec![false; funcs.len()];
    let mut any = false;
    for f in funcs.ids() {
        if funcs.get(f).name == pattern {
            hits[f as usize] = true;
            any = true;
        }
    }
    if !any {
        let p = pattern.to_lowercase();
        for f in funcs.ids() {
            let func = funcs.get(f);
            if format!("{} {}", func.name, func.loc)
                .to_lowercase()
                .contains(&p)
            {
                hits[f as usize] = true;
                any = true;
            }
        }
    }
    if any {
        Ok(hits)
    } else {
        Err(format!("no function's name or location has {pattern}"))
    }
}

/// Whether a function's name says nothing on its own: an anonymous function, or a script's top level.
/// Whether a function's name says nothing on its own: it has none, or a minifier gave it one.
pub fn nameless(func: &Func) -> bool {
    let base = func.name.split('$').next().unwrap_or(&func.name);
    let minified = !base.is_empty() && base.len() <= 2;
    let anonymous = func.name == "(anonymous)" || func.name == "(top level)";
    (anonymous || minified) && !func.loc.is_empty()
}

/// A name with where it is: `(anonymous src/a.ts:3)`, `Ze (index.js:1)`.
pub fn name_at(name: &str, loc: &str) -> String {
    match name.strip_suffix(')') {
        Some(inner) if name.starts_with('(') => format!("{inner} {loc})"),
        _ => format!("{name} ({loc})"),
    }
}

/// What to pass to --root or --callers to name a function again.
pub fn func_arg(funcs: &Funcs, f: FuncId) -> String {
    let func = funcs.get(f);
    if nameless(func) {
        func.loc.clone()
    } else {
        func.name.clone()
    }
}

/// A function's name, with its location when the name alone says nothing.
pub fn short_name(funcs: &Funcs, f: FuncId) -> String {
    let func = funcs.get(f);
    if nameless(func) {
        name_at(&func.name, &func.loc)
    } else {
        func.name.clone()
    }
}

/// Call paths, merged, with the time spent in each.
pub struct Tree {
    pub nodes: Vec<TreeNode>,
}

pub struct TreeNode {
    pub func: FuncId,
    pub total: f64,
    pub self_us: f64,
    pub children: Vec<usize>,
}

impl Tree {
    pub fn new() -> Self {
        let root = TreeNode {
            func: FuncId::MAX,
            total: 0.0,
            self_us: 0.0,
            children: Vec::new(),
        };
        Tree { nodes: vec![root] }
    }

    pub fn add(&mut self, path: impl Iterator<Item = FuncId>, w: f64) {
        let mut cur = 0;
        self.nodes[0].total += w;
        for f in path {
            let found = self.nodes[cur]
                .children
                .iter()
                .copied()
                .find(|&c| self.nodes[c].func == f);
            let next = match found {
                Some(c) => c,
                None => {
                    let c = self.nodes.len();
                    self.nodes.push(TreeNode {
                        func: f,
                        total: 0.0,
                        self_us: 0.0,
                        children: Vec::new(),
                    });
                    self.nodes[cur].children.push(c);
                    c
                }
            };
            self.nodes[next].total += w;
            cur = next;
        }
        self.nodes[cur].self_us += w;
    }
}
