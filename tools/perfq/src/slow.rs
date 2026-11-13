// The slow moments of using an app: clicks and key presses that took long to show their result,
// and stretches of long frames, which make scrolling, animation and streamed text stutter.

use std::collections::HashMap;
use std::fmt::Write;

use crate::Opts;
use crate::fmt::{Table, arg, at, ms, seconds};
use crate::model::{Funcs, Interaction, LONG_FRAME, LongFrame, Run};
use crate::query;
use crate::report::{hints, what_ran, works_in};
use crate::stats::median;

/// Long frames closer than this make one stretch.
const JOIN: f64 = 1_000_000.0;
const PAD: &str = "         ";

pub fn slow(runs: &[Run], o: &Opts, funcs: &Funcs) -> Result<String, String> {
    o.filter.check(runs)?;
    let budget = o.min.unwrap_or(100.0) * 1000.0;
    let limit = o.limit.unwrap_or(10);
    let mut all: Vec<(&Run, &Interaction)> = Vec::new();
    let mut stretches: Vec<Stretch> = Vec::new();
    for run in runs {
        let windows = o.filter.windows(run);
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
        stretches.extend(group(run, frames));
    }

    let mut out = String::new();
    let length: f64 = runs.iter().map(|r| r.end - r.start).sum();
    let recorded = if runs.len() == 1 {
        format!("1 run, {} recorded", seconds(length))
    } else {
        format!("{} runs, {} recorded in all", runs.len(), seconds(length))
    };
    let scope = o.filter.describe(runs);
    let mut slow: Vec<(&Run, &Interaction)> = all
        .iter()
        .copied()
        .filter(|(_, i)| i.dur() > budget)
        .collect();
    slow.sort_by(|a, b| b.1.dur().total_cmp(&a.1.dur()));
    if all.is_empty() {
        let _ = writeln!(
            out,
            "{recorded}{scope}: no clicks or key presses. Record while using the app; in dodocode: pnpm trace --until-closed"
        );
    } else {
        let _ = writeln!(
            out,
            "{recorded}{scope}: {} clicks and key presses, {} of them took over {} to show their result",
            all.len(),
            slow.len(),
            ms(budget)
        );
    }

    if !slow.is_empty() {
        out += &actions(&all, budget, limit);
        out += "\nthe slowest, with what ran meanwhile. waiting: the page was busy with something else; handlers: the event's own code; drawing: rendering the result to the screen.\n";
        for &(run, i) in slow.iter().take(limit) {
            let _ = writeln!(
                out,
                "\n{:>7}  {}  at {}{}",
                ms(i.dur()),
                i.label(),
                at(i.start - run.start),
                place(runs, run)
            );
            let _ = writeln!(
                out,
                "{PAD}waiting {}, handlers {}, drawing {}",
                ms(i.waiting),
                ms(i.handling),
                ms(i.drawing)
            );
            out += &stretch_lines(run, &[(i.start, i.end)], funcs);
        }
        if slow.len() > limit {
            let _ = writeln!(out, "\n{} more: --limit {}", slow.len() - limit, slow.len());
        }
    }

    let outside = if slow.is_empty() {
        ""
    } else {
        ", outside the slow ones above"
    };
    stretches.sort_by(|a, b| b.total().total_cmp(&a.total()));
    if stretches.is_empty() {
        let _ = writeln!(
            out,
            "\nno frames of {} or more after launch{outside}",
            ms(LONG_FRAME)
        );
    } else {
        let _ = writeln!(
            out,
            "\nchoppy stretches: frames of {} or more after launch{outside}, joined when under {} apart; worst first",
            ms(LONG_FRAME),
            seconds(JOIN)
        );
        for s in stretches.iter().take(limit) {
            let what = if s.frames.len() == 1 {
                format!("1 frame of {}", ms(s.total()))
            } else {
                format!(
                    "{} long frames, {} in all, longest {}",
                    s.frames.len(),
                    ms(s.total()),
                    ms(s.longest())
                )
            };
            let _ = writeln!(
                out,
                "\n  at {}-{}{}  {what}",
                at(s.start() - s.run.start),
                at(s.end() - s.run.start),
                place(runs, s.run)
            );
            out += &stretch_lines(s.run, &s.frames, funcs);
        }
        if stretches.len() > limit {
            let _ = writeln!(
                out,
                "\n{} more: --limit {}",
                stretches.len() - limit,
                stretches.len()
            );
        }
    }

    let mut next = Vec::new();
    if let Some(&(run, i)) = slow.first() {
        next.extend(look(run, i.start, i.end, "the slowest click or key press"));
    }
    if let Some(s) = stretches.first() {
        next.extend(look(s.run, s.start(), s.end(), "the worst choppy stretch"));
    }
    out += &hints(&next);
    Ok(out)
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
    let mut out = format!(
        "\nthe actions that took over {} at least once. typical: half the times were faster.\n",
        ms(budget)
    );
    let mut table = Table::new(&[
        ("action", false),
        ("times", true),
        ("slow", true),
        ("typical", true),
        ("slowest", true),
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
    out += &table.render();
    if rows.len() > limit {
        let _ = writeln!(out, "{} more: --limit {}", rows.len() - limit, rows.len());
    }
    let never = kinds - rows.len();
    if never > 0 {
        let s = if never == 1 { "" } else { "s" };
        let _ = writeln!(
            out,
            "{never} other action{s} never took over {}",
            ms(budget)
        );
    }
    out
}

/// Long frames close together.
struct Stretch<'a> {
    run: &'a Run,
    frames: Vec<(f64, f64)>,
}

impl Stretch<'_> {
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

fn group<'a>(run: &'a Run, frames: impl Iterator<Item = &'a LongFrame>) -> Vec<Stretch<'a>> {
    let mut out: Vec<Stretch> = Vec::new();
    for f in frames {
        match out.last_mut() {
            Some(s) if f.start - s.end() < JOIN => s.frames.push((f.start, f.end)),
            _ => out.push(Stretch {
                run,
                frames: vec![(f.start, f.end)],
            }),
        }
    }
    out
}

/// The renderer's work in some stretches of a run, and what ran in them.
fn stretch_lines(run: &Run, windows: &[(f64, f64)], funcs: &Funcs) -> String {
    let mut out = String::new();
    if let Some(t) = run.thread("renderer") {
        let works = works_in(t, windows);
        if !works.is_empty() {
            let _ = writeln!(out, "{PAD}renderer: {works}");
        }
    }
    out + &what_ran(run, "renderer", windows, funcs, PAD)
}

fn place(runs: &[Run], run: &Run) -> String {
    if runs.len() > 1 {
        format!(" in {}", run.name)
    } else {
        String::new()
    }
}

/// The commands that look into a stretch of a run, function by function and as a call tree.
fn look(run: &Run, start: f64, end: f64, what: &str) -> Vec<(String, String)> {
    let from = ((start - run.start) / 1000.0).floor() / 1000.0;
    let to = ((end - run.start) / 1000.0).ceil() / 1000.0;
    let source = arg(&run.source);
    vec![
        (
            format!("perfq top {source} --window {from:.3}-{to:.3}"),
            format!("{what}, function by function"),
        ),
        (
            format!("perfq tree {source} --window {from:.3}-{to:.3}"),
            format!("{what}, as a call tree"),
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(start: f64, end: f64) -> LongFrame {
        LongFrame { start, end }
    }

    #[test]
    fn long_frames_under_a_second_apart_make_one_stretch() {
        let run = Run {
            name: String::new(),
            source: String::new(),
            start: 0.0,
            end: 0.0,
            threads: Vec::new(),
            spans: Vec::new(),
            interactions: Vec::new(),
            long_frames: Vec::new(),
        };
        // 0.9s from the first's end to the second's start, then 1s to the third.
        let frames = [
            frame(0.0, 60_000.0),
            frame(960_000.0, 1_040_000.0),
            frame(2_040_000.0, 2_100_000.0),
        ];
        let stretches = group(&run, frames.iter());
        let got: Vec<(f64, f64, usize, f64)> = stretches
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
