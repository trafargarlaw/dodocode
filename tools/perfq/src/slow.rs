// The slow moments of using an app: clicks and key presses that took long to show their result,
// and stutters: stretches of long frames, which make scrolling, animation and streamed text jerk.

use std::collections::HashMap;
use std::fmt::Write;

use crate::Opts;
use crate::fmt::{Table, arg, at, field, fields, items, ms, seconds};
use crate::model::{Funcs, Interaction, LongFrame, Run};
use crate::query;
use crate::report::{details, hints, look, more, run_place};
use crate::stats::median;

/// Long frames closer than this make one stutter.
const JOIN: f64 = 1_000_000.0;
/// How many seconds after an untimed input to look for its work.
const UNTIMED_LOOK: f64 = 0.5;

pub fn slow(runs: &[Run], o: &Opts, funcs: &Funcs) -> Result<String, String> {
    o.filter.check(runs)?;
    let budget = o.min.unwrap_or(100.0) * 1000.0;
    let limit = o.limit.unwrap_or(10);
    let mut all: Vec<(&Run, &Interaction)> = Vec::new();
    let mut untimed: Vec<(&Run, &(f64, String))> = Vec::new();
    let mut stutters: Vec<Stutter> = Vec::new();
    for run in runs {
        let windows = o.filter.windows(run);
        let marked = run.untimed.iter().filter(|u| query::inside(&windows, u.0));
        untimed.extend(marked.map(|u| (run, u)));
        let mine: Vec<&Interaction> = run
            .interactions
            .iter()
            .filter(|i| query::inside(&windows, i.start))
            .collect();
        let slow: Vec<(f64, f64)> = mine
            .iter()
            .filter(|i| i.dur() > budget)
            .map(|i| (i.start, i.end))
            .collect();
        all.extend(mine.iter().map(|i| (run, *i)));
        // Launch has long frames of its own, and summary covers it.
        let launched = run
            .spans
            .iter()
            .find(|s| s.name == "startup")
            .map_or(run.start, |s| s.end);
        let frames = run.long_frames.iter().filter(|f| {
            f.start >= launched
                && query::inside(&windows, f.start)
                && !slow.iter().any(|s| s.0 < f.end && s.1 > f.start)
        });
        stutters.extend(group(run, frames));
    }
    let mut slow: Vec<(&Run, &Interaction)> = all
        .iter()
        .copied()
        .filter(|(_, i)| i.dur() > budget)
        .collect();
    slow.sort_by(|a, b| b.1.dur().total_cmp(&a.1.dur()));
    stutters.sort_by(|a, b| b.total().total_cmp(&a.total()));

    let mut out = String::new();
    let length: f64 = runs.iter().map(|r| r.end - r.start).sum();
    let mut head = vec![
        field("runs", runs.len().to_string()),
        field("recorded", seconds(length)),
    ];
    head.extend(o.filter.fields(runs));
    head.extend([
        field("budget", ms(budget)),
        field("interactions", all.len().to_string()),
        field("slow", slow.len().to_string()),
        field("stutters", stutters.len().to_string()),
    ]);
    if !untimed.is_empty() {
        head.push(field("untimed", untimed.len().to_string()));
    }
    out += &fields("", &head);

    if !slow.is_empty() {
        out += "\n## slow actions\n";
        out += &actions(&all, budget, limit);
        out += "\n## slowest\n";
        for (rank, &(run, i)) in slow.iter().take(limit).enumerate() {
            let _ = writeln!(
                out,
                "\n### {}  {}  at {}  {}{}",
                rank + 1,
                ms(i.dur()),
                at(i.start - run.start),
                i.label(),
                run_place(runs, run)
            );
            let mut rows = vec![field("phases", phases(i))];
            rows.extend(details(run, "renderer", &[(i.start, i.end)], funcs));
            out += &fields("", &rows);
        }
        if slow.len() > limit {
            out.push('\n');
            out += &more(slow.len() - limit, slow.len());
        }
    }

    if !stutters.is_empty() {
        out += "\n## stutters\n";
        for (rank, s) in stutters.iter().take(limit).enumerate() {
            let _ = writeln!(
                out,
                "\n### {}  {}  at {}-{}{}",
                rank + 1,
                ms(s.total()),
                at(s.start() - s.run.start),
                at(s.end() - s.run.start),
                run_place(runs, s.run)
            );
            let parts = [
                ("n", s.frames.len().to_string()),
                ("longest", ms(s.longest())),
            ];
            let mut rows = vec![field("long frames", items(&parts))];
            rows.extend(details(s.run, "renderer", &s.frames, funcs));
            out += &fields("", &rows);
        }
        if stutters.len() > limit {
            out.push('\n');
            out += &more(stutters.len() - limit, stutters.len());
        }
    }

    if !untimed.is_empty() {
        out += "\n## untimed\n";
        let several = runs.len() > 1;
        let mut columns = vec![("at", true), ("action", false)];
        if several {
            columns.push(("run", false));
        }
        let mut table = Table::new(&columns);
        for &(run, (t, name)) in untimed.iter().take(limit) {
            let mut row = vec![at(t - run.start), name.clone()];
            if several {
                row.push(run.name.clone());
            }
            table.row(row);
        }
        out += &table.render();
        if untimed.len() > limit {
            out.push('\n');
            out += &more(untimed.len() - limit, untimed.len());
        }
    }

    let mut next = Vec::new();
    if let Some(&(run, (t, _))) = untimed.first() {
        let from = ((t - run.start) / 1000.0).floor() / 1000.0;
        next.push((
            format!(
                "perfq tasks {} --window {from:.3}-{:.3} --min 10",
                arg(&run.source),
                from + UNTIMED_LOOK
            ),
            "first untimed: its tasks".to_string(),
        ));
    }
    if all.is_empty() && untimed.is_empty() {
        next.push((
            "pnpm trace --until-closed".to_string(),
            "dodocode: record while using the app".to_string(),
        ));
    }
    if let Some(&(run, i)) = slow.first() {
        next.extend(look(run, i.start, i.end, "renderer", "slowest interaction"));
    }
    if let Some(s) = stutters.first() {
        next.extend(look(s.run, s.start(), s.end(), "renderer", "worst stutter"));
    }
    out += &hints(&next);
    Ok(out)
}

/// Where an interaction's time went, from the input to its frame on screen.
fn phases(i: &Interaction) -> String {
    let mut parts = vec![("waiting", ms(i.waiting)), ("handlers", ms(i.handling))];
    match i.presenting {
        Some(presenting) => {
            parts.push(("render", ms(i.rendering)));
            parts.push(("present", ms(presenting)));
        }
        None => parts.push(("drawing", ms(i.rendering))),
    }
    items(&parts)
}

/// The actions that were slow at least once: how often each happened, and how long it took.
fn actions(all: &[(&Run, &Interaction)], budget: f64, limit: usize) -> String {
    let mut by: HashMap<&str, Vec<f64>> = HashMap::new();
    for (_, i) in all {
        by.entry(i.label()).or_default().push(i.dur());
    }
    let kinds = by.len();
    let slowest = |d: &[f64]| d.iter().copied().fold(0.0, f64::max);
    let mut rows: Vec<(&str, Vec<f64>)> = by
        .into_iter()
        .filter(|(_, d)| slowest(d) > budget)
        .collect();
    rows.sort_by(|a, b| slowest(&b.1).total_cmp(&slowest(&a.1)));
    let mut table = Table::new(&[
        ("action", false),
        ("n", true),
        ("slow", true),
        ("p50", true),
        ("max", true),
    ]);
    for (label, d) in rows.iter().take(limit) {
        table.row(vec![
            label.to_string(),
            d.len().to_string(),
            d.iter().filter(|&&d| d > budget).count().to_string(),
            ms(median(d)),
            ms(slowest(d)),
        ]);
    }
    let never = kinds - rows.len();
    if never > 0 {
        let cells = vec![
            format!("({never} other actions)"),
            String::new(),
            "0".into(),
        ];
        table.row(cells);
    }
    let mut out = table.render();
    if rows.len() > limit {
        out += &more(rows.len() - limit, rows.len());
    }
    out
}

/// Long frames close together.
struct Stutter<'a> {
    run: &'a Run,
    frames: Vec<(f64, f64)>,
}

impl Stutter<'_> {
    fn start(&self) -> f64 {
        self.frames[0].0
    }

    fn end(&self) -> f64 {
        self.frames[self.frames.len() - 1].1
    }

    fn total(&self) -> f64 {
        self.frames.iter().map(|f| f.1 - f.0).sum()
    }

    fn longest(&self) -> f64 {
        self.frames.iter().map(|f| f.1 - f.0).fold(0.0, f64::max)
    }
}

fn group<'a>(run: &'a Run, frames: impl Iterator<Item = &'a LongFrame>) -> Vec<Stutter<'a>> {
    let mut out: Vec<Stutter> = Vec::new();
    for f in frames {
        match out.last_mut() {
            Some(s) if f.start - s.end() < JOIN => s.frames.push((f.start, f.end)),
            _ => out.push(Stutter {
                run,
                frames: vec![(f.start, f.end)],
            }),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(start: f64, end: f64) -> LongFrame {
        LongFrame { start, end }
    }

    #[test]
    fn long_frames_under_a_second_apart_make_one_stutter() {
        let run = Run::new(String::new(), String::new());
        // 0.9s from the first's end to the second's start, then 1s to the third.
        let frames = [
            frame(0.0, 60_000.0),
            frame(960_000.0, 1_040_000.0),
            frame(2_040_000.0, 2_100_000.0),
        ];
        let stutters = group(&run, frames.iter());
        let got: Vec<(f64, f64, usize, f64)> = stutters
            .iter()
            .map(|s| (s.start(), s.end(), s.frames.len(), s.total()))
            .collect();
        assert_eq!(
            got,
            [
                (0.0, 1_040_000.0, 2, 140_000.0),
                (2_040_000.0, 2_100_000.0, 1, 60_000.0)
            ]
        );
    }
}
