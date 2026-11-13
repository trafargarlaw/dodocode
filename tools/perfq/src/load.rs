// Reads runs from disk. A run is a Chrome trace (`<run>.trace.json`, as apps/desktop/src/main/
// tracing.ts or the DevTools Performance panel saves one) with the server's CPU profile beside it
// (`<run>.server.cpuprofile`), or a CPU profile alone (`*.cpuprofile`, as Node's inspector writes).

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::model::{
    FuncKind, Funcs, Interaction, LONG_FRAME, LongFrame, NO_PARENT, Node, Profile, Run, Sample,
    Slice, Span, Task, Thread, Work,
};
use crate::symbols::{CallFrame, Symbols};

const TRACE: &str = ".trace.json";
const SERVER_PROFILE: &str = ".server.cpuprofile";
const PROFILE: &str = ".cpuprofile";
/// The source maps of the build a run ran, saved with it.
const MAPS: &str = ".maps.json";

struct RunFiles {
    name: String,
    trace: Option<PathBuf>,
    profile: Option<PathBuf>,
    maps: Option<PathBuf>,
}

/// Every run the inputs name, as files or folders of them, in the order given.
pub fn load(inputs: &[String], symbols: &mut Symbols) -> Result<Vec<Run>, String> {
    let mut runs = Vec::new();
    for input in inputs {
        for files in find(Path::new(input))? {
            runs.push(read_run(files, symbols)?);
        }
    }
    Ok(runs)
}

fn find(path: &Path) -> Result<Vec<RunFiles>, String> {
    if path.is_file() {
        let file = file_name(path);
        if file.ends_with(PROFILE) {
            let name = strip(&file, &[SERVER_PROFILE, PROFILE]);
            let maps = beside(path, &format!("{name}{MAPS}"));
            return Ok(vec![RunFiles {
                name,
                trace: None,
                profile: Some(path.to_path_buf()),
                maps,
            }]);
        }
        let name = strip(&file, &[TRACE, ".json"]);
        let profile = beside(path, &format!("{name}{SERVER_PROFILE}"));
        let maps = beside(path, &format!("{name}{MAPS}"));
        return Ok(vec![RunFiles {
            name,
            trace: Some(path.to_path_buf()),
            profile,
            maps,
        }]);
    }
    if !path.is_dir() {
        return Err(format!("no such file or folder: {}", path.display()));
    }
    let mut files: Vec<PathBuf> = fs::read_dir(path)
        .map_err(|e| format!("could not read {}: {e}", path.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .filter(|p| p.is_file())
        .collect();
    files.sort();
    let mut traces: Vec<&PathBuf> = files
        .iter()
        .filter(|p| file_name(p).ends_with(TRACE))
        .collect();
    if traces.is_empty() {
        traces = files
            .iter()
            .filter(|p| file_name(p).ends_with(".json") && !file_name(p).ends_with(MAPS))
            .collect();
    }
    let mut runs = Vec::new();
    for trace in traces {
        let name = strip(&file_name(trace), &[TRACE, ".json"]);
        let profile = beside(trace, &format!("{name}{SERVER_PROFILE}"));
        let maps = beside(trace, &format!("{name}{MAPS}"));
        runs.push(RunFiles {
            name,
            trace: Some(trace.clone()),
            profile,
            maps,
        });
    }
    for file in &files {
        let fname = file_name(file);
        if !fname.ends_with(PROFILE) || runs.iter().any(|r| r.profile.as_ref() == Some(file)) {
            continue;
        }
        let name = strip(&fname, &[SERVER_PROFILE, PROFILE]);
        let maps = beside(file, &format!("{name}{MAPS}"));
        runs.push(RunFiles {
            name,
            trace: None,
            profile: Some(file.clone()),
            maps,
        });
    }
    if runs.is_empty() {
        return Err(format!(
            "no runs in {}: perfq reads *.trace.json and *.cpuprofile files",
            path.display()
        ));
    }
    Ok(runs)
}

/// The file of this name in the same folder, when there is one.
fn beside(path: &Path, name: &str) -> Option<PathBuf> {
    let other = path.with_file_name(name);
    other.is_file().then_some(other)
}

fn read_run(files: RunFiles, symbols: &mut Symbols) -> Result<Run, String> {
    let source = files.trace.as_ref().or(files.profile.as_ref()).unwrap();
    // A file is written as its recording ends.
    let recorded = fs::metadata(source).and_then(|m| m.modified()).ok();
    symbols.begin_run(files.maps.as_deref(), recorded);
    let mut run = Run {
        name: files.name,
        source: source.to_string_lossy().replace('\\', "/"),
        start: f64::INFINITY,
        end: f64::NEG_INFINITY,
        threads: Vec::new(),
        spans: Vec::new(),
        interactions: Vec::new(),
        long_frames: Vec::new(),
    };
    if let Some(path) = &files.trace {
        read_trace(path, &mut run, symbols)?;
    }
    if let Some(path) = &files.profile {
        let paired = files.trace.is_some() || file_name(path).ends_with(SERVER_PROFILE);
        let label = if paired { "server" } else { "node" };
        let (thread, start, end) = read_cpuprofile(path, label, symbols)?;
        run.start = run.start.min(start);
        run.end = run.end.max(end);
        run.threads.push(thread);
    }
    if !run.start.is_finite() {
        run.start = 0.0;
        run.end = 0.0;
    }
    run.spans.sort_by(|a, b| a.start.total_cmp(&b.start));
    Ok(run)
}

// ---- Chrome traces ----

#[derive(Deserialize)]
struct TraceObject<'a> {
    #[serde(rename = "traceEvents", borrow)]
    trace_events: Vec<Event<'a>>,
}

#[derive(Deserialize)]
struct Event<'a> {
    #[serde(borrow, default)]
    ph: Cow<'a, str>,
    #[serde(borrow, default)]
    name: Cow<'a, str>,
    #[serde(borrow, default)]
    cat: Cow<'a, str>,
    #[serde(borrow, default)]
    pid: Option<&'a RawValue>,
    #[serde(borrow, default)]
    tid: Option<&'a RawValue>,
    #[serde(default)]
    ts: f64,
    #[serde(default)]
    dur: Option<f64>,
    #[serde(borrow, default)]
    id: Option<&'a RawValue>,
    #[serde(borrow, default)]
    id2: Option<&'a RawValue>,
    #[serde(borrow, default)]
    args: Option<&'a RawValue>,
}

/// A thread: its process and thread ids, as the trace writes them.
type Key<'a> = (&'a str, &'a str);

/// A complete event on a thread: a task, a function call, a layout...
struct Ev<'a> {
    start: f64,
    end: f64,
    name: &'a str,
    cat: &'a str,
}

#[derive(Default)]
struct Sampled<'a> {
    thread: Option<Key<'a>>,
    start: f64,
    chunks: Vec<(f64, &'a RawValue)>,
}

#[derive(Deserialize)]
struct NameArgs {
    #[serde(default)]
    name: String,
}

#[derive(Deserialize)]
struct StartArgs {
    data: StartData,
}

#[derive(Deserialize)]
struct StartData {
    #[serde(rename = "startTime")]
    start_time: f64,
}

/// One event's Event Timing, in milliseconds on the page's clock.
#[derive(Deserialize)]
struct TimingArgs {
    data: TimingData,
}

#[derive(Deserialize)]
struct TimingData {
    /// The interaction the event belongs to; 0 for events that are none (mousemove, scroll...).
    #[serde(rename = "interactionId", default)]
    interaction_id: f64,
    #[serde(rename = "type", default)]
    kind: String,
    #[serde(rename = "timeStamp", default)]
    time_stamp: f64,
    #[serde(rename = "processingStart", default)]
    processing_start: f64,
    #[serde(rename = "processingEnd", default)]
    processing_end: f64,
}

impl TimingData {
    /// The event as an interaction, from its start to its end on the trace's clock.
    fn interaction(&self, start: f64, end: f64) -> Interaction {
        let dur = (end - start).max(0.0);
        let waiting = ((self.processing_start - self.time_stamp) * 1000.0).clamp(0.0, dur);
        let handling =
            ((self.processing_end - self.processing_start) * 1000.0).clamp(0.0, dur - waiting);
        Interaction {
            start,
            end: start + dur,
            event: self.kind.clone(),
            name: None,
            waiting,
            handling,
            drawing: dur - waiting - handling,
        }
    }
}

/// An interaction's longest event, and when each of its events started.
type Timed = (Option<Interaction>, Vec<f64>);

/// The marks the app leaves on each click and key press (apps/desktop/src/renderer/perf.ts), at
/// the event's time: `interaction:click button "Board"`.
const INTERACTION: &str = "interaction:";

#[derive(Deserialize)]
struct ChunkArgs {
    data: ChunkData,
}

#[derive(Deserialize)]
struct ChunkData {
    #[serde(rename = "cpuProfile", default)]
    cpu_profile: ChunkProfile,
    #[serde(rename = "timeDeltas", default)]
    time_deltas: Vec<f64>,
}

#[derive(Deserialize, Default)]
struct ChunkProfile {
    #[serde(default)]
    nodes: Vec<RawNode>,
    #[serde(default)]
    samples: Vec<u64>,
}

/// A call tree node, from a trace (which names its parent) or a .cpuprofile (its children).
#[derive(Deserialize)]
struct RawNode {
    id: u64,
    #[serde(rename = "callFrame")]
    call_frame: CallFrame,
    #[serde(default)]
    parent: Option<u64>,
    #[serde(default)]
    children: Vec<u64>,
}

fn read_trace(path: &Path, run: &mut Run, symbols: &mut Symbols) -> Result<(), String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    read_trace_text(&text, &path.display().to_string(), run, symbols)
}

/// Reads a trace's text, from the file `origin` names.
fn read_trace_text(
    text: &str,
    origin: &str,
    run: &mut Run,
    symbols: &mut Symbols,
) -> Result<(), String> {
    let text = text.trim_start_matches('\u{feff}');
    let events =
        parse_events(text).map_err(|e| format!("{origin} is not a trace perfq can read: {e}"))?;

    let mut names: HashMap<Key, String> = HashMap::new();
    let mut by_thread: HashMap<Key, Vec<Ev>> = HashMap::new();
    let mut begun: HashMap<Key, Vec<(f64, &str, &str)>> = HashMap::new();
    let mut measures: HashMap<(&str, &str, &str), f64> = HashMap::new();
    let mut sampled: HashMap<Key, Sampled> = HashMap::new();
    // Event Timing's events, begun and not yet ended, by process and id.
    let mut timing: HashMap<(&str, &str), (f64, TimingData)> = HashMap::new();
    let mut timed: HashMap<(&str, u64), Timed> = HashMap::new();
    let mut frames: HashMap<(&str, &str), f64> = HashMap::new();
    let mut long_frames: Vec<(&str, LongFrame)> = Vec::new();
    let mut marks: Vec<(f64, &str)> = Vec::new();

    for e in &events {
        let key = (raw(e.pid), raw(e.tid));
        let ph = e.ph.as_ref();
        if ph != "M" && e.ts > 0.0 {
            run.start = run.start.min(e.ts);
            run.end = run.end.max(e.ts + e.dur.unwrap_or(0.0));
        }
        match ph {
            "M" if e.name == "thread_name" => {
                if let Some(name) = e
                    .args
                    .and_then(|a| serde_json::from_str::<NameArgs>(a.get()).ok())
                {
                    names.insert(key, name.name);
                }
            }
            "X" => by_thread.entry(key).or_default().push(Ev {
                start: e.ts,
                end: e.ts + e.dur.unwrap_or(0.0),
                name: &e.name,
                cat: &e.cat,
            }),
            "B" => begun.entry(key).or_default().push((e.ts, &e.name, &e.cat)),
            "E" => {
                if let Some((start, name, cat)) = begun.get_mut(&key).and_then(|open| open.pop()) {
                    by_thread.entry(key).or_default().push(Ev {
                        start,
                        end: e.ts,
                        name,
                        cat,
                    });
                }
            }
            "b" if e.name == "EventTiming" => {
                let args = e
                    .args
                    .and_then(|a| serde_json::from_str::<TimingArgs>(a.get()).ok());
                if let Some(args) = args
                    && args.data.interaction_id > 0.0
                {
                    timing.insert((key.0, raw(e.id2.or(e.id))), (e.ts, args.data));
                }
            }
            "e" if e.name == "EventTiming" => {
                if let Some((start, data)) = timing.remove(&(key.0, raw(e.id2.or(e.id)))) {
                    let event = data.interaction(start, e.ts);
                    let (longest, starts) = timed
                        .entry((key.0, data.interaction_id as u64))
                        .or_default();
                    starts.push(start);
                    if longest.as_ref().is_none_or(|l| event.dur() > l.dur()) {
                        *longest = Some(event);
                    }
                }
            }
            "b" if e.name == "AnimationFrame" => {
                frames.insert((key.0, raw(e.id2.or(e.id))), e.ts);
            }
            "e" if e.name == "AnimationFrame" => {
                if let Some(start) = frames.remove(&(key.0, raw(e.id2.or(e.id))))
                    && e.ts - start >= LONG_FRAME
                {
                    long_frames.push((key.0, LongFrame { start, end: e.ts }));
                }
            }
            "R" | "I" | "i" | "n" if is_user_timing(&e.cat) => {
                if let Some(name) = e.name.strip_prefix(INTERACTION) {
                    marks.push((e.ts, name));
                }
            }
            "b" | "S" if is_user_timing(&e.cat) => {
                measures.insert((key.0, raw(e.id2.or(e.id)), &e.name), e.ts);
            }
            "e" | "F" if is_user_timing(&e.cat) => {
                if let Some(start) = measures.remove(&(key.0, raw(e.id2.or(e.id)), e.name.as_ref()))
                {
                    run.spans.push(Span {
                        name: e.name.to_string(),
                        start,
                        end: e.ts,
                    });
                }
            }
            "P" => {
                // A profile's chunks come from the sampling thread, so they are matched to it by id.
                let profile = sampled.entry((key.0, raw(e.id))).or_default();
                if e.name == "Profile" {
                    profile.thread = Some(key);
                    let start = e
                        .args
                        .and_then(|a| serde_json::from_str::<StartArgs>(a.get()).ok());
                    profile.start = start.map_or(e.ts, |s| s.data.start_time);
                } else if e.name == "ProfileChunk"
                    && let Some(args) = e.args
                {
                    profile.chunks.push((e.ts, args));
                }
            }
            _ => {}
        }
    }

    let profiled: Vec<Key> = sampled.values().filter_map(|p| p.thread).collect();
    let threads = label_threads(&names, &profiled, &by_thread);
    // The app's page; other renderers are DevTools or helpers.
    let app = threads.iter().find(|t| t.0 == "renderer").map(|t| t.1.0);
    for ((pid, _), (longest, starts)) in timed {
        if Some(pid) == app
            && let Some(mut interaction) = longest
        {
            interaction.name = mark_near(&marks, &starts).map(str::to_string);
            run.interactions.push(interaction);
        }
    }
    run.interactions.sort_by(|a, b| a.start.total_cmp(&b.start));
    let frames = long_frames.into_iter().filter(|f| Some(f.0) == app);
    run.long_frames.extend(frames.map(|f| f.1));
    run.long_frames.sort_by(|a, b| a.start.total_cmp(&b.start));

    for (label, key) in threads {
        let mut events = by_thread.remove(&key).unwrap_or_default();
        events.sort_by(|a, b| a.start.total_cmp(&b.start).then(b.end.total_cmp(&a.end)));
        let tasks = find_tasks(&events);
        let mut slices = event_slices(&events);
        let profile = match sampled.values().find(|p| p.thread == Some(key)) {
            Some(p) => Some(chunk_profile(p, symbols).map_err(|e| format!("{origin}: {e}"))?),
            None => None,
        };
        if let Some(profile) = &profile {
            slices = refine(slices, profile, &symbols.funcs);
        }
        run.threads.push(Thread {
            label,
            profile,
            tasks,
            slices,
        });
    }
    Ok(())
}

/// The name of the mark left at one of an interaction's events, which start at `starts`.
fn mark_near<'a>(marks: &[(f64, &'a str)], starts: &[f64]) -> Option<&'a str> {
    // Both record the event's own time: they differ by rounding alone.
    const NEAR: f64 = 1000.0;
    marks
        .iter()
        .filter_map(|&(at, name)| {
            let off = starts
                .iter()
                .map(|s| (s - at).abs())
                .min_by(f64::total_cmp)?;
            (off <= NEAR).then_some((off, name))
        })
        .min_by(|a, b| a.0.total_cmp(&b.0))
        .map(|m| m.1)
}

fn parse_events(text: &str) -> Result<Vec<Event<'_>>, serde_json::Error> {
    if text.trim_start().starts_with('[') {
        serde_json::from_str(text)
    } else {
        serde_json::from_str::<TraceObject>(text).map(|t| t.trace_events)
    }
}

fn raw(value: Option<&RawValue>) -> &str {
    value.map_or("", |v| v.get())
}

fn is_user_timing(cat: &str) -> bool {
    cat.contains("user_timing") || cat.contains("usertiming")
}

/// The threads worth reading, with the names `--thread` takes: each process's main thread, and any
/// other thread the profiler sampled.
fn label_threads<'a>(
    names: &HashMap<Key<'a>, String>,
    profiled: &[Key<'a>],
    events: &HashMap<Key<'a>, Vec<Ev>>,
) -> Vec<(String, Key<'a>)> {
    let mut mains: [(&str, Vec<Key>); 3] =
        [("renderer", vec![]), ("browser", vec![]), ("gpu", vec![])];
    let mut others = Vec::new();
    for (key, name) in names {
        let main = match name.as_str() {
            "CrRendererMain" => 0,
            "CrBrowserMain" => 1,
            "CrGpuMain" => 2,
            _ => {
                if profiled.contains(key) {
                    others.push((name.to_lowercase().replace(' ', "-"), *key));
                }
                continue;
            }
        };
        mains[main].1.push(*key);
    }
    for key in profiled {
        if !names.contains_key(key) {
            others.push((format!("thread-{}", key.1), *key));
        }
    }
    let mut out = Vec::new();
    for (base, mut keys) in mains {
        // A second renderer is usually DevTools or a helper page: the busiest one is the app.
        keys.sort_by_key(|k| std::cmp::Reverse(events.get(k).map_or(0, Vec::len)));
        for (i, key) in keys.into_iter().enumerate() {
            let label = if i == 0 {
                base.to_string()
            } else {
                format!("{base}-{}", i + 1)
            };
            out.push((label, key));
        }
    }
    others.sort();
    out.extend(others);
    out
}

/// The tasks the thread's event loop ran: its outermost scheduler events.
fn find_tasks(events: &[Ev]) -> Vec<Task> {
    let mut tasks = Vec::new();
    let mut last = f64::NEG_INFINITY;
    for e in events {
        let task = e.name == "RunTask" || e.cat.split(',').any(|c| c == "toplevel");
        if task && e.start >= last {
            tasks.push(Task {
                start: e.start,
                end: e.end,
            });
            last = e.end;
        }
    }
    tasks
}

/// What kind of work an event is, as the Performance panel groups them; None takes its parent's.
fn classify(name: &str, cat: &str) -> Option<Work> {
    let gc = ["V8.GC", "MinorGC", "MajorGC", "BlinkGC", "CppGC"];
    if cat.contains("v8.gc") || gc.iter().any(|p| name.starts_with(p)) {
        return Some(Work::Gc);
    }
    Some(match name {
        "FunctionCall"
        | "EvaluateScript"
        | "v8.evaluateModule"
        | "RunMicrotasks"
        | "BlinkScheduler_PerformMicrotaskCheckpoint"
        | "TimerFire"
        | "FireAnimationFrame"
        | "FireIdleCallback"
        | "EventDispatch"
        | "XHRReadyStateChange"
        | "XHRLoad"
        | "V8.Execute"
        | "v8.run"
        | "v8.callFunction" => Work::Script,
        "ParseHTML"
        | "ParseAuthorStyleSheet"
        | "v8.compile"
        | "v8.compileModule"
        | "V8.CompileCode"
        | "v8.parseOnBackground"
        | "v8.produceCache"
        | "v8.produceModuleCache"
        | "v8.deserializeCache"
        | "CompileScript"
        | "CacheScript" => Work::Parse,
        "UpdateLayoutTree" | "RecalculateStyles" => Work::Style,
        "Layout" => Work::Layout,
        "Paint" | "PrePaint" | "Layerize" | "Commit" | "UpdateLayer" | "UpdateLayerTree"
        | "CompositeLayers" | "PaintImage" | "Decode Image" | "ImageDecodeTask" | "Rasterize"
        | "RasterTask" => Work::Paint,
        _ => return None,
    })
}

/// The thread's busy time cut into slices of one kind of work. Each moment goes to the innermost
/// event there that has a kind, so a layout a script forces counts as layout.
fn event_slices(events: &[Ev]) -> Vec<Slice> {
    let mut out = Vec::new();
    let mut stack: Vec<(f64, Option<Work>)> = Vec::new();
    let mut at = f64::NEG_INFINITY;
    for e in events {
        close_until(&mut stack, &mut at, e.start, &mut out);
        if !stack.is_empty() {
            push(&mut out, at, e.start, current(&stack));
        }
        at = e.start;
        // An event that outlasts its parent is cut at the parent's end.
        let end = stack.last().map_or(e.end, |top| e.end.min(top.0));
        stack.push((end, classify(e.name, e.cat)));
    }
    close_until(&mut stack, &mut at, f64::INFINITY, &mut out);
    out
}

fn close_until(stack: &mut Vec<(f64, Option<Work>)>, at: &mut f64, t: f64, out: &mut Vec<Slice>) {
    while let Some(&(end, _)) = stack.last() {
        if end > t {
            break;
        }
        push(out, *at, end, current(stack));
        *at = at.max(end);
        stack.pop();
    }
}

fn current(stack: &[(f64, Option<Work>)]) -> Work {
    stack.iter().rev().find_map(|s| s.1).unwrap_or(Work::Other)
}

fn push(out: &mut Vec<Slice>, start: f64, end: f64, work: Work) {
    if end <= start {
        return;
    }
    if let Some(last) = out.last_mut()
        && last.work == work
        && last.end == start
    {
        last.end = end;
        return;
    }
    out.push(Slice { start, end, work });
}

/// Splits the slices no event explains by what the CPU samples there show: a script, the garbage
/// collector, or neither. The browser's main thread runs Electron's JavaScript without the events
/// a page's scripts get.
fn refine(slices: Vec<Slice>, profile: &Profile, funcs: &Funcs) -> Vec<Slice> {
    let samples = &profile.samples;
    let mut out = Vec::with_capacity(slices.len());
    let mut first = 0;
    for s in slices {
        if s.work != Work::Other {
            push(&mut out, s.start, s.end, s.work);
            continue;
        }
        while first < samples.len() && samples[first].t + samples[first].w <= s.start {
            first += 1;
        }
        let mut at = s.start;
        for sample in samples[first..].iter().take_while(|x| x.t < s.end) {
            let from = sample.t.max(s.start);
            let to = (sample.t + sample.w).min(s.end);
            if to <= from {
                continue;
            }
            push(&mut out, at, from, Work::Other);
            push(
                &mut out,
                from,
                to,
                sample_work(profile, sample, funcs).unwrap_or(Work::Other),
            );
            at = to;
        }
        push(&mut out, at, s.end, Work::Other);
    }
    out
}

/// What a sample shows the thread doing; None when it was idle.
fn sample_work(profile: &Profile, sample: &Sample, funcs: &Funcs) -> Option<Work> {
    match funcs.get(profile.nodes[sample.node as usize].func).kind {
        FuncKind::Js | FuncKind::Native => Some(Work::Script),
        FuncKind::Gc => Some(Work::Gc),
        FuncKind::Program => Some(Work::Other),
        FuncKind::Idle | FuncKind::Root => None,
    }
}

fn chunk_profile(p: &Sampled, symbols: &mut Symbols) -> Result<Profile, String> {
    let mut chunks = p.chunks.clone();
    chunks.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut nodes = Vec::new();
    let mut samples = Vec::new();
    let mut t = p.start;
    for (_, args) in chunks {
        let args: ChunkArgs = serde_json::from_str(args.get())
            .map_err(|e| format!("a CPU profile chunk perfq cannot read: {e}"))?;
        let data = args.data;
        nodes.extend(data.cpu_profile.nodes);
        for (i, &node) in data.cpu_profile.samples.iter().enumerate() {
            t += data.time_deltas.get(i).copied().unwrap_or(0.0);
            samples.push((t, node));
        }
    }
    Ok(build_profile(nodes, samples, symbols))
}

// ---- .cpuprofile ----

#[derive(Deserialize)]
struct CpuProfile {
    nodes: Vec<RawNode>,
    #[serde(rename = "startTime")]
    start_time: f64,
    #[serde(rename = "endTime", default)]
    end_time: f64,
    #[serde(default)]
    samples: Vec<u64>,
    #[serde(rename = "timeDeltas", default)]
    time_deltas: Vec<f64>,
}

fn read_cpuprofile(
    path: &Path,
    label: &str,
    symbols: &mut Symbols,
) -> Result<(Thread, f64, f64), String> {
    let text =
        fs::read_to_string(path).map_err(|e| format!("could not read {}: {e}", path.display()))?;
    let p: CpuProfile = serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| {
        format!(
            "{} is not a CPU profile perfq can read: {e}",
            path.display()
        )
    })?;
    let mut t = p.start_time;
    let mut samples = Vec::with_capacity(p.samples.len());
    for (i, &node) in p.samples.iter().enumerate() {
        t += p.time_deltas.get(i).copied().unwrap_or(0.0);
        samples.push((t, node));
    }
    let end = if p.end_time > 0.0 { p.end_time } else { t };
    let profile = build_profile(p.nodes, samples, symbols);
    let slices = sample_slices(&profile, &symbols.funcs);
    let thread = Thread {
        label: label.to_string(),
        profile: Some(profile),
        tasks: Vec::new(),
        slices,
    };
    Ok((thread, p.start_time, end))
}

/// A thread known only from its samples is busy wherever a sample is not idle.
fn sample_slices(profile: &Profile, funcs: &Funcs) -> Vec<Slice> {
    let mut out = Vec::new();
    for s in &profile.samples {
        if let Some(work) = sample_work(profile, s, funcs) {
            push(&mut out, s.t, s.t + s.w, work);
        }
    }
    out
}

fn build_profile(raw: Vec<RawNode>, samples: Vec<(f64, u64)>, symbols: &mut Symbols) -> Profile {
    let index: HashMap<u64, u32> = raw
        .iter()
        .enumerate()
        .map(|(i, n)| (n.id, i as u32))
        .collect();
    let mut parents = vec![NO_PARENT; raw.len()];
    for (i, n) in raw.iter().enumerate() {
        if let Some(&p) = n.parent.and_then(|p| index.get(&p)) {
            parents[i] = p;
        }
        for c in &n.children {
            if let Some(&c) = index.get(c) {
                parents[c as usize] = i as u32;
            }
        }
    }
    let nodes = raw
        .iter()
        .zip(parents)
        .map(|(n, parent)| Node {
            parent,
            func: symbols.func(&n.call_frame),
        })
        .collect();

    let mut samples: Vec<(f64, u32)> = samples
        .into_iter()
        .filter_map(|(t, id)| index.get(&id).map(|&i| (t, i)))
        .collect();
    samples.sort_by(|a, b| a.0.total_cmp(&b.0));
    let mut gaps: Vec<f64> = samples
        .windows(2)
        .map(|w| w[1].0 - w[0].0)
        .filter(|g| *g > 0.0)
        .collect();
    gaps.sort_by(f64::total_cmp);
    let interval = gaps.get(gaps.len() / 2).copied().unwrap_or(1000.0);
    // A long gap means the profiler paused, not that the last stack ran all along.
    let cap = interval * 10.0;
    let samples = (0..samples.len())
        .map(|i| {
            let (t, node) = samples[i];
            let w = samples
                .get(i + 1)
                .map_or(interval, |next| (next.0 - t).min(cap));
            Sample { t, node, w }
        })
        .collect();
    Profile {
        nodes,
        samples,
        interval,
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default()
}

fn strip(name: &str, suffixes: &[&str]) -> String {
    for suffix in suffixes {
        if let Some(stem) = name.strip_suffix(suffix) {
            return stem.to_string();
        }
    }
    name.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(start: f64, end: f64, name: &'static str) -> Ev<'static> {
        Ev {
            start,
            end,
            name,
            cat: "",
        }
    }

    fn kinds(slices: &[Slice]) -> Vec<(f64, f64, &'static str)> {
        slices
            .iter()
            .map(|s| (s.start, s.end, s.work.label()))
            .collect()
    }

    #[test]
    fn the_innermost_kind_wins() {
        // A task running a script that forces a layout, then paints.
        let events = [
            ev(0.0, 100.0, "RunTask"),
            ev(10.0, 60.0, "FunctionCall"),
            ev(20.0, 30.0, "Layout"),
            ev(70.0, 90.0, "Paint"),
        ];
        let slices = event_slices(&events);
        assert_eq!(
            kinds(&slices),
            vec![
                (0.0, 10.0, "other"),
                (10.0, 20.0, "script"),
                (20.0, 30.0, "layout"),
                (30.0, 60.0, "script"),
                (60.0, 70.0, "other"),
                (70.0, 90.0, "paint"),
                (90.0, 100.0, "other"),
            ]
        );
    }

    #[test]
    fn clicks_and_long_frames_come_from_the_app_page() {
        // One click: its pointerdown took 20ms, its click 120ms, of which 10ms waiting for the
        // thread and 80ms in handlers. The app marked the pointerdown, 0.3ms off by rounding.
        let trace = r#"[
            {"ph":"M","name":"thread_name","pid":1,"tid":1,"args":{"name":"CrRendererMain"}},
            {"ph":"X","name":"RunTask","cat":"toplevel","pid":1,"tid":1,"ts":1000,"dur":10},
            {"ph":"b","name":"EventTiming","cat":"devtools.timeline","pid":1,"tid":1,"ts":1000000,"id2":{"local":"0x1"},
             "args":{"data":{"type":"pointerdown","interactionId":7,"timeStamp":1000,"processingStart":1000.5,"processingEnd":1001}}},
            {"ph":"e","name":"EventTiming","cat":"devtools.timeline","pid":1,"tid":1,"ts":1020000,"id2":{"local":"0x1"},"args":{}},
            {"ph":"b","name":"EventTiming","cat":"devtools.timeline","pid":1,"tid":1,"ts":1090000,"id2":{"local":"0x2"},
             "args":{"data":{"type":"click","interactionId":7,"timeStamp":1090,"processingStart":1100,"processingEnd":1180}}},
            {"ph":"e","name":"EventTiming","cat":"devtools.timeline","pid":1,"tid":1,"ts":1210000,"id2":{"local":"0x2"},"args":{}},
            {"ph":"b","name":"EventTiming","cat":"devtools.timeline","pid":1,"tid":1,"ts":3000000,"id2":{"local":"0x3"},
             "args":{"data":{"type":"mousemove","interactionId":0,"timeStamp":3000,"processingStart":3000,"processingEnd":3200}}},
            {"ph":"e","name":"EventTiming","cat":"devtools.timeline","pid":1,"tid":1,"ts":3300000,"id2":{"local":"0x3"},"args":{}},
            {"ph":"b","name":"EventTiming","cat":"devtools.timeline","pid":2,"tid":5,"ts":4000000,"id2":{"local":"0x1"},
             "args":{"data":{"type":"keydown","interactionId":9,"timeStamp":4000,"processingStart":4000,"processingEnd":4300}}},
            {"ph":"e","name":"EventTiming","cat":"devtools.timeline","pid":2,"tid":5,"ts":4400000,"id2":{"local":"0x1"},"args":{}},
            {"ph":"R","name":"interaction:click button \"Board\"","cat":"blink.user_timing","pid":1,"tid":1,"ts":1000300},
            {"ph":"R","name":"interaction:typing in textarea","cat":"blink.user_timing","pid":1,"tid":1,"ts":5000000},
            {"ph":"b","name":"AnimationFrame","cat":"devtools.timeline","pid":1,"tid":1,"ts":1000000,"id2":{"local":"0x26"},"args":{}},
            {"ph":"e","name":"AnimationFrame","cat":"devtools.timeline","pid":1,"tid":1,"ts":1030000,"id2":{"local":"0x26"},"args":{}},
            {"ph":"b","name":"AnimationFrame","cat":"devtools.timeline","pid":1,"tid":1,"ts":1030000,"id2":{"local":"0x26"},"args":{}},
            {"ph":"e","name":"AnimationFrame","cat":"devtools.timeline","pid":1,"tid":1,"ts":1090000,"id2":{"local":"0x26"},"args":{}}
        ]"#;
        let mut run = Run {
            name: String::new(),
            source: String::new(),
            start: f64::INFINITY,
            end: f64::NEG_INFINITY,
            threads: Vec::new(),
            spans: Vec::new(),
            interactions: Vec::new(),
            long_frames: Vec::new(),
        };
        read_trace_text(trace, "test", &mut run, &mut Symbols::new()).unwrap();
        let interactions: Vec<_> = run
            .interactions
            .iter()
            .map(|i| {
                let parts = (i.waiting, i.handling, i.drawing);
                (i.start, i.end, i.event.as_str(), i.name.as_deref(), parts)
            })
            .collect();
        assert_eq!(
            interactions,
            [(
                1_090_000.0,
                1_210_000.0,
                "click",
                Some("click button \"Board\""),
                (10_000.0, 80_000.0, 30_000.0)
            )]
        );
        let frames: Vec<_> = run.long_frames.iter().map(|f| (f.start, f.end)).collect();
        assert_eq!(frames, [(1_030_000.0, 1_090_000.0)]);
    }

    #[test]
    fn nested_scheduler_events_are_one_task() {
        let events = [
            ev(0.0, 100.0, "RunTask"),
            ev(0.0, 100.0, "RunTask"),
            ev(150.0, 160.0, "RunTask"),
        ];
        let tasks = find_tasks(&events);
        assert_eq!(
            tasks.iter().map(|t| (t.start, t.end)).collect::<Vec<_>>(),
            [(0.0, 100.0), (150.0, 160.0)]
        );
    }
}
