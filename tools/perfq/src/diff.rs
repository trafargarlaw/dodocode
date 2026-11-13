// diff: two sets of runs, before and after a change, side by side. Each change gets a verdict that
// says whether it stands out from run-to-run noise, so one lucky run does not read as a win.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt::Write;

use crate::Opts;
use crate::fmt::{Table, arg, field, fields, items, ms, signed_ms, signed_pct};
use crate::model::{FuncId, Funcs, Run};
use crate::query::{self, Need};
use crate::report::more;
use crate::stats::{ALPHA, can_show_change, mann_whitney, median};

pub fn diff(before: &[Run], after: &[Run], o: &Opts, funcs: &Funcs) -> Result<String, String> {
    let mut out = String::new();
    let side =
        |runs: &[Run], path: &str| items(&[("runs", runs.len().to_string()), ("path", arg(path))]);
    let mut head = vec![
        field("before", side(before, &o.inputs[0])),
        field("after", side(after, &o.inputs[1])),
    ];
    head.extend(o.filter.fields(before));
    head.push(field(
        "test",
        format!("mann-whitney-u, two-sided, p<{ALPHA}"),
    ));
    out += &fields("", &head);

    // Spans: every instance counts.
    let (a, b) = (span_values(before), span_values(after));
    let mut names: Vec<&String> = a
        .keys()
        .chain(b.keys())
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    let total = |n: &String| {
        a.get(n).map_or(0.0, |v| v.iter().sum::<f64>()) + b.get(n).map_or(0.0, |v| v.iter().sum())
    };
    names.sort_by(|x, y| total(y).total_cmp(&total(x)));
    if !names.is_empty() {
        let limit = o.limit.unwrap_or(15);
        let mut table = Table::new(&[
            ("span", false),
            ("n", true),
            ("before", true),
            ("after", true),
            ("change", true),
            ("verdict", false),
        ]);
        for name in names.iter().take(limit) {
            let va = a.get(*name).cloned().unwrap_or_default();
            let vb = b.get(*name).cloned().unwrap_or_default();
            table.row(compare(name, &va, &vb, "faster", "slower"));
        }
        out += "\n## spans\n";
        out += &table.render();
        if names.len() > limit {
            out += &more(names.len() - limit, names.len());
        }
    }

    // Busy time per run, by thread.
    let mut labels = query::labels(before);
    for l in query::labels(after) {
        if !labels.contains(&l) {
            labels.push(l);
        }
    }
    let mut table = Table::new(&[
        ("thread", false),
        ("n", true),
        ("before", true),
        ("after", true),
        ("change", true),
        ("verdict", false),
    ]);
    for label in &labels {
        let busy = |runs: &[Run]| -> Vec<f64> {
            runs.iter()
                .filter_map(|r| {
                    r.thread(label)
                        .map(|t| query::work_in(t, &o.filter.windows(r)).values().sum())
                })
                .collect()
        };
        table.row(compare(label, &busy(before), &busy(after), "less", "more"));
    }
    out += "\n## busy per run\n";
    out += &table.render();

    // Functions: self time per run.
    let thread = query::pick_thread(before, o.thread.as_deref(), Need::Samples)?;
    let per_run = |runs: &[Run]| -> Vec<HashMap<FuncId, f64>> {
        runs.iter()
            .filter_map(|r| query::weigh_run(r, &thread, &o.filter.windows(r), funcs))
            .map(|w| w.self_us)
            .collect()
    };
    let (fa, fb) = (per_run(before), per_run(after));
    let _ = writeln!(out, "\n## self time per run: {thread}");
    if fb.is_empty() {
        let runs = [("before", fa.len().to_string()), ("after", "0".to_string())];
        out += &fields("", &[field("runs with samples", items(&runs))]);
        return Ok(out);
    }
    let ids: HashSet<FuncId> = fa
        .iter()
        .chain(fb.iter())
        .flat_map(|m| m.keys().copied())
        .collect();
    let values = |maps: &[HashMap<FuncId, f64>], f: FuncId| -> Vec<f64> {
        maps.iter()
            .map(|m| m.get(&f).copied().unwrap_or(0.0))
            .collect()
    };
    let mut changes: Vec<(FuncId, Vec<f64>, Vec<f64>, f64)> = ids
        .into_iter()
        .map(|f| {
            let (va, vb) = (values(&fa, f), values(&fb, f));
            let change = median(&vb) - median(&va);
            (f, va, vb, change)
        })
        .filter(|c| c.3.abs() >= 100.0)
        .collect();
    changes.sort_by(|x, y| y.3.abs().total_cmp(&x.3.abs()));
    if changes.is_empty() {
        out += "none\n";
        return Ok(out);
    }
    let limit = o.limit.unwrap_or(15);
    let mut table = Table::new(&[
        ("change", true),
        ("before", true),
        ("after", true),
        ("verdict", false),
        ("function", false),
        ("location", false),
    ]);
    for (f, va, vb, change) in changes.iter().take(limit) {
        let func = funcs.get(*f);
        table.row(vec![
            signed_ms(*change),
            ms(median(va)),
            ms(median(vb)),
            verdict(va, vb, "less", "more"),
            func.name.clone(),
            func.loc.clone(),
        ]);
    }
    out += &table.render();
    if changes.len() > limit {
        out += &more(changes.len() - limit, changes.len());
    }
    Ok(out)
}

fn span_values(runs: &[Run]) -> BTreeMap<String, Vec<f64>> {
    let mut out: BTreeMap<String, Vec<f64>> = BTreeMap::new();
    for run in runs {
        for s in &run.spans {
            out.entry(s.name.clone()).or_default().push(s.dur());
        }
    }
    out
}

/// A row: what, n before/after, the medians, the change and its verdict.
fn compare(what: &str, a: &[f64], b: &[f64], lower: &str, higher: &str) -> Vec<String> {
    let n = format!("{}/{}", a.len(), b.len());
    if a.is_empty() || b.is_empty() {
        let side = if a.is_empty() {
            "only after"
        } else {
            "only before"
        };
        let show = |v: &[f64]| {
            if v.is_empty() {
                "-".to_string()
            } else {
                ms(median(v))
            }
        };
        return vec![
            what.to_string(),
            n,
            show(a),
            show(b),
            String::new(),
            side.to_string(),
        ];
    }
    let (ma, mb) = (median(a), median(b));
    vec![
        what.to_string(),
        n,
        ms(ma),
        ms(mb),
        format!("{} {}", signed_ms(mb - ma), signed_pct(mb - ma, ma)),
        verdict(a, b, lower, higher),
    ]
}

fn verdict(a: &[f64], b: &[f64], lower: &str, higher: &str) -> String {
    if !can_show_change(a.len(), b.len()) {
        return "too few".to_string();
    }
    let p = mann_whitney(a, b);
    if p >= ALPHA {
        return format!("unclear (p={p:.2})");
    }
    let (ma, mb) = (median(a), median(b));
    let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
    let lower_now = if mb == ma { mean(b) < mean(a) } else { mb < ma };
    format!("{} (p={p:.3})", if lower_now { lower } else { higher })
}
