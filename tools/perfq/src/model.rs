// What perfq reads out of a trace: runs, their threads, CPU samples, tasks and spans.
// Every time is in microseconds on the trace's clock. A CPU profile written beside a trace by the
// same machine uses the same clock, so its samples line up with the trace's spans.

use std::collections::HashMap;

pub type FuncId = u32;
pub const NO_PARENT: u32 = u32::MAX;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FuncKind {
    Js,
    Native,
    /// The engine's own work outside JavaScript: style, layout, paint, message handling.
    Program,
    Idle,
    Gc,
    Root,
}

pub struct Func {
    pub name: String,
    /// `path:line`, made short; empty for the profiler's own entries.
    pub loc: String,
    pub kind: FuncKind,
    /// The app's own code: JavaScript from outside `node_modules` and the runtime.
    pub own: bool,
}

/// Every function seen in every run, so runs can be added up and compared by function.
#[derive(Default)]
pub struct Funcs {
    list: Vec<Func>,
    index: HashMap<(String, String), FuncId>,
}

impl Funcs {
    pub fn intern(&mut self, name: String, loc: String, kind: FuncKind, own: bool) -> FuncId {
        let key = (name, loc);
        if let Some(&id) = self.index.get(&key) {
            return id;
        }
        let id = self.list.len() as FuncId;
        self.list.push(Func {
            name: key.0.clone(),
            loc: key.1.clone(),
            kind,
            own,
        });
        self.index.insert(key, id);
        id
    }

    pub fn get(&self, id: FuncId) -> &Func {
        &self.list[id as usize]
    }

    pub fn ids(&self) -> impl Iterator<Item = FuncId> {
        0..self.list.len() as FuncId
    }

    pub fn len(&self) -> usize {
        self.list.len()
    }
}

pub struct Node {
    pub parent: u32,
    pub func: FuncId,
}

pub struct Sample {
    pub t: f64,
    pub node: u32,
    /// The time this sample stands for: until the next one.
    pub w: f64,
}

pub struct Profile {
    pub nodes: Vec<Node>,
    pub samples: Vec<Sample>,
    /// The usual time between samples.
    pub interval: f64,
}

/// What a thread's time went to, from the trace's own events.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Work {
    Script,
    Style,
    Layout,
    Paint,
    Gc,
    Parse,
    /// Inside a task, but none of the above.
    Other,
}

pub const WORKS: [Work; 7] = [
    Work::Script,
    Work::Style,
    Work::Layout,
    Work::Paint,
    Work::Gc,
    Work::Parse,
    Work::Other,
];

impl Work {
    pub fn label(self) -> &'static str {
        match self {
            Work::Script => "script",
            Work::Style => "style",
            Work::Layout => "layout",
            Work::Paint => "paint",
            Work::Gc => "gc",
            Work::Parse => "parse",
            Work::Other => "other",
        }
    }
}

/// A stretch of a thread's time spent on one kind of work. A thread's slices never overlap.
pub struct Slice {
    pub start: f64,
    pub end: f64,
    pub work: Work,
}

/// A task the thread's event loop ran.
pub struct Task {
    pub start: f64,
    pub end: f64,
}

impl Task {
    pub fn dur(&self) -> f64 {
        self.end - self.start
    }
}

pub struct Thread {
    /// `renderer`, `browser`, `server`...: what --thread takes.
    pub label: String,
    pub profile: Option<Profile>,
    pub tasks: Vec<Task>,
    pub slices: Vec<Slice>,
}

impl Thread {
    /// Time in each kind of work between `start` and `end`.
    pub fn work_between(&self, start: f64, end: f64) -> HashMap<Work, f64> {
        let mut out = HashMap::new();
        let first = self.slices.partition_point(|s| s.end <= start);
        for s in &self.slices[first..] {
            if s.start >= end {
                break;
            }
            let overlap = s.end.min(end) - s.start.max(start);
            if overlap > 0.0 {
                *out.entry(s.work).or_insert(0.0) += overlap;
            }
        }
        out
    }
}

/// A performance.measure() span.
pub struct Span {
    pub name: String,
    pub start: f64,
    pub end: f64,
}

impl Span {
    pub fn dur(&self) -> f64 {
        self.end - self.start
    }
}

/// A click, tap or key press, from the input to the frame that showed its result. Chrome times
/// each one (Event Timing). An interaction fires several events (pointerdown, pointerup, click):
/// the one that took longest stands for it, as it does for Chrome's own Interaction to Next Paint.
pub struct Interaction {
    pub start: f64,
    pub end: f64,
    /// That event's type: click, keydown, pointerup...
    pub event: String,
    /// What the app called it, from its `interaction:<what>` span: `click button "Board"`.
    pub name: Option<String>,
    /// Until the event's handlers started: the thread was busy with something else.
    pub waiting: f64,
    /// The event's handlers.
    pub handling: f64,
    /// From the handlers to the frame on screen: rendering, style, layout and paint.
    pub drawing: f64,
}

impl Interaction {
    pub fn dur(&self) -> f64 {
        self.end - self.start
    }

    /// The app's name for it, or else the event's type.
    pub fn label(&self) -> &str {
        self.name.as_deref().unwrap_or(&self.event)
    }
}

/// How long a frame takes before it counts as long.
pub const LONG_FRAME: f64 = 50_000.0;

/// A frame that took 50ms or more, from the work that started it to its paint (a long animation
/// frame). Many in a row make scrolling, animation or streamed text stutter.
pub struct LongFrame {
    pub start: f64,
    pub end: f64,
}

pub struct Run {
    pub name: String,
    /// The file it was read from, for the commands perfq suggests.
    pub source: String,
    pub start: f64,
    pub end: f64,
    pub threads: Vec<Thread>,
    pub spans: Vec<Span>,
    /// The renderer's clicks and key presses, in order.
    pub interactions: Vec<Interaction>,
    /// The renderer's frames of 50ms or more, in order.
    pub long_frames: Vec<LongFrame>,
}

impl Run {
    pub fn thread(&self, label: &str) -> Option<&Thread> {
        self.threads.iter().find(|t| t.label == label)
    }
}
