// tree: the call tree from the top, from a function down (--root), or from a function up to its
// callers (--callers). Calls under a share of the time are left out, and a chain of calls that
// only pass the time on shows on one line.

use std::collections::HashMap;

use crate::Opts;
use crate::fmt::{Table, arg, cell_ms, field, fields, ms, pct};
use crate::model::{FuncId, FuncKind, Funcs, Run};
use crate::query::{self, Need, Tree};
use crate::report::{hints, scope_flags};

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Top,
    Root,
    Callers,
}

pub fn tree(runs: &[Run], o: &Opts, funcs: &Funcs) -> Result<String, String> {
    let thread = query::pick_thread(runs, o.thread.as_deref(), Need::Samples)?;
    o.filter.check(runs)?;
    let (mode, pattern) = match (&o.root, &o.callers) {
        (Some(_), Some(_)) => return Err("--root and --callers do not go together".to_string()),
        (Some(p), None) => (Mode::Root, Some(p.as_str())),
        (None, Some(p)) => (Mode::Callers, Some(p.as_str())),
        (None, None) => (Mode::Top, None),
    };
    let hits = pattern.map(|p| query::match_funcs(funcs, p)).transpose()?;
    let hit = |f: &FuncId| hits.as_ref().is_some_and(|h| h[*f as usize]);

    let mut tree = Tree::new();
    let mut busy = 0.0;
    let mut used = 0;
    let mut st = Vec::new();
    for run in runs {
        let Some(profile) = run.thread(&thread).and_then(|t| t.profile.as_ref()) else {
            continue;
        };
        used += 1;
        let windows = o.filter.windows(run);
        for s in &profile.samples {
            if !query::inside(&windows, s.t) || query::is_idle(profile, s, funcs) {
                continue;
            }
            busy += s.w;
            query::stack(profile, s.node, funcs, &mut st);
            match mode {
                Mode::Top => tree.add(st.iter().copied(), s.w),
                // From the outermost call, so a recursive function counts once.
                Mode::Root => {
                    if let Some(i) = st.iter().position(hit) {
                        tree.add(st[i..].iter().copied(), s.w);
                    }
                }
                Mode::Callers => {
                    if let Some(i) = st.iter().rposition(hit) {
                        tree.add(st[..=i].iter().rev().copied(), s.w);
                    }
                }
            }
        }
    }

    let per = used.max(1) as f64;
    let whole = tree.nodes[0].total;
    let min_pct = o.min.unwrap_or(1.0);
    let base = if mode == Mode::Top { busy } else { whole };
    let min = base * min_pct / 100.0;
    let mut out = String::new();
    let pattern = pattern.unwrap_or_default();
    let mut head = vec![
        field("thread", thread.clone()),
        field("runs", used.to_string()),
    ];
    head.extend(o.filter.fields(runs));
    head.push(field("busy", ms(busy / per)));
    match mode {
        Mode::Top => {}
        Mode::Root => head.push(field("root", pattern)),
        Mode::Callers => head.push(field("callers of", pattern)),
    }
    if mode != Mode::Top {
        head.push(field("total", ms(whole / per)));
        head.push(field("share", pct(whole, busy)));
    }
    let base = if mode == Mode::Top { "busy" } else { "total" };
    head.push(field(
        "min",
        format!("{min_pct}% of {base}, {}", ms(min / per)),
    ));
    out += &fields("", &head);
    if whole <= 0.0 {
        return Ok(out);
    }
    out.push('\n');

    let mut render = Render {
        tree: &tree,
        funcs,
        min,
        per,
        max_depth: o.depth.unwrap_or(24),
        callers: mode == Mode::Callers,
        lines: Vec::new(),
        deeper: false,
    };
    for child in render.big_children(0) {
        render.walk(child, 0);
    }
    let limit = o.limit.unwrap_or(40);
    let hidden = render.lines.len().saturating_sub(limit);
    let deeper = render.deeper;
    let mut lines = render.lines;
    lines.truncate(limit);
    let mut table = if mode == Mode::Callers {
        Table::new(&[("total", true), ("function", false)])
    } else {
        Table::new(&[("total", true), ("self", true), ("function", false)])
    };
    for [total, self_us, text] in lines {
        if mode == Mode::Callers {
            table.row(vec![total, text]);
        } else {
            table.row(vec![total, self_us, text]);
        }
    }
    out += &table.render();
    let mut tail = Vec::new();
    if hidden > 0 {
        tail.push(field(
            "more",
            format!("{hidden} lines, --limit --min --depth --root"),
        ));
    }
    if deeper {
        tail.push(field("cut", format!("depth {}", o.depth.unwrap_or(24))));
    }
    if !tail.is_empty() {
        out.push('\n');
        out += &fields("", &tail);
    }

    // Where the most self time in the tree is, to follow it up.
    let mut by_func: HashMap<FuncId, f64> = HashMap::new();
    for node in &tree.nodes[1..] {
        *by_func.entry(node.func).or_insert(0.0) += node.self_us;
    }
    let inputs = o.input_args();
    let flags = scope_flags(o, &thread);
    let mut next = Vec::new();
    let hottest = by_func
        .iter()
        .filter(|(f, _)| funcs.get(**f).kind == FuncKind::Js)
        .max_by(|a, b| a.1.total_cmp(b.1))
        .map(|(f, _)| *f);
    match mode {
        Mode::Callers => next.push((
            format!("perfq tree {inputs}{flags} --root {}", arg(pattern)),
            "callees".to_string(),
        )),
        _ => {
            if let Some(f) = hottest {
                next.push((
                    format!(
                        "perfq tree {inputs}{flags} --callers {}",
                        arg(&query::func_arg(funcs, f))
                    ),
                    "most self time: callers".to_string(),
                ));
            }
        }
    }
    out += &hints(&next);
    Ok(out)
}

struct Render<'a> {
    tree: &'a Tree,
    funcs: &'a Funcs,
    min: f64,
    per: f64,
    max_depth: usize,
    callers: bool,
    lines: Vec<[String; 3]>,
    deeper: bool,
}

impl Render<'_> {
    fn walk(&mut self, node: usize, depth: usize) {
        let nodes = &self.tree.nodes;
        // Calls that pass nearly all their time on to one callee share a line.
        let mut chain = vec![node];
        let mut cur = node;
        loop {
            let big = self.big_children(cur);
            let n = &nodes[cur];
            let passes_on = big.len() == 1
                && (self.callers || n.self_us < self.min)
                && nodes[big[0]].total >= 0.9 * n.total;
            if !passes_on {
                break;
            }
            cur = big[0];
            chain.push(cur);
        }
        let funcs: Vec<FuncId> = chain.iter().map(|&c| nodes[c].func).collect();
        let sep = if self.callers { " < " } else { " > " };
        let names = fold(&funcs, |&f| chain_name(self.funcs, f), sep);
        // A long chain keeps its ends: the calls next to the line's own, which say the most, and
        // the far end, which places it.
        let names = if names.len() > 8 {
            let skipped = names.len() - 6;
            format!(
                "{}{sep}... {skipped} calls ...{sep}{}",
                names[..4].join(sep),
                names[names.len() - 2..].join(sep)
            )
        } else {
            names.join(sep)
        };
        let last = self.funcs.get(nodes[cur].func);
        let loc = if last.loc.is_empty() {
            String::new()
        } else {
            format!("  {}", last.loc)
        };
        self.lines.push([
            ms(nodes[node].total / self.per),
            cell_ms(nodes[cur].self_us / self.per),
            format!("{}{names}{loc}", "  ".repeat(depth)),
        ]);
        let kids = self.big_children(cur);
        if depth + 1 >= self.max_depth {
            self.deeper |= !kids.is_empty();
            return;
        }
        for kid in kids {
            self.walk(kid, depth + 1);
        }
    }

    fn big_children(&self, node: usize) -> Vec<usize> {
        let nodes = &self.tree.nodes;
        let mut kids: Vec<usize> = nodes[node]
            .children
            .iter()
            .copied()
            .filter(|&c| nodes[c].total >= self.min)
            .collect();
        kids.sort_by(|a, b| nodes[*b].total.total_cmp(&nodes[*a].total));
        kids
    }
}

/// Recursion shows once with a count: `a > b > a > b > a > b` is `(a > b) x3`. Calls are the same
/// when they are the same function, not when they share a name.
fn fold<T: PartialEq>(names: &[T], name: impl Fn(&T) -> String, sep: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < names.len() {
        // The period that repeats over the most calls from here, the shortest on a tie.
        let mut best = (1, 1);
        for p in 1..=3 {
            let mut k = 1;
            while i + p * (k + 1) <= names.len()
                && names[i..i + p] == names[i + p * k..i + p * (k + 1)]
            {
                k += 1;
            }
            if k >= 2 && p * k > best.0 * best.1 {
                best = (p, k);
            }
        }
        let (p, k) = best;
        if k >= 2 {
            let unit = names[i..i + p]
                .iter()
                .map(&name)
                .collect::<Vec<_>>()
                .join(sep);
            out.push(if p == 1 {
                format!("{unit} x{k}")
            } else {
                format!("({unit}) x{k}")
            });
        } else {
            out.push(name(&names[i]));
        }
        i += p * k;
    }
    out
}

/// A name for a call in a chain: an anonymous function goes by its file and line, short.
fn chain_name(funcs: &Funcs, f: FuncId) -> String {
    let func = funcs.get(f);
    if !query::nameless(func) {
        return func.name.clone();
    }
    let file = func.loc.rsplit('/').next().unwrap_or(&func.loc);
    query::name_at(&func.name, file)
}

#[cfg(test)]
mod tests {
    use super::fold;

    #[test]
    fn recursion_folds() {
        let names = |ids: &[u32]| {
            fold(
                ids,
                |&id| ["work", "a", "b", "leaf", "spawn", "spawn"][id as usize].to_string(),
                " > ",
            )
        };
        assert_eq!(
            names(&[0, 1, 2, 1, 2, 1, 2, 3]),
            ["work", "(a > b) x3", "leaf"]
        );
        assert_eq!(names(&[1, 1, 3]), ["a x2", "leaf"]);
        // Two functions named alike are not recursion.
        assert_eq!(names(&[4, 5, 3]), ["spawn", "spawn", "leaf"]);
    }
}
