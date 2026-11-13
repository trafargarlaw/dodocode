// Turns a profiler's call frame into a function to show: its name and a short `path:line`.
// A frame in a bundle is mapped back to its source through the source map of the build that ran:
// the one the run saved (`<run>.maps.json`), else the one beside the bundle (`<file>.map`) or that
// the bundle names, when the bundle has not been rebuilt since the run.

use std::collections::HashMap;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::time::SystemTime;

use serde::Deserialize;
use sourcemap::SourceMap;

use crate::model::{FuncId, FuncKind, Funcs};

#[derive(Deserialize)]
pub struct CallFrame {
    #[serde(rename = "functionName", default)]
    pub function_name: String,
    #[serde(default)]
    pub url: String,
    /// 0-based, or -1 when the frame has no position.
    #[serde(rename = "lineNumber", default = "minus_one")]
    pub line: i64,
    #[serde(rename = "columnNumber", default = "minus_one")]
    pub column: i64,
}

fn minus_one() -> i64 {
    -1
}

pub struct Symbols {
    pub funcs: Funcs,
    /// The folder perfq runs in: paths in no repository show relative to it.
    cwd: String,
    /// Each folder's repository root, found once.
    roots: HashMap<String, Option<String>>,
    /// Source maps by the file they were read from: a saved map, or a bundle.
    maps: HashMap<String, Option<SourceMap>>,
    frames: HashMap<(String, String, i64, i64), FuncId>,
    /// The run being read: the maps it saved, by bundle path in lowercase, and when it was
    /// recorded.
    run_maps: HashMap<String, PathBuf>,
    recorded: Option<SystemTime>,
    /// Whether each bundle changed after the run being read was recorded.
    rebuilt: HashMap<String, bool>,
    /// What a reader should know about the locations shown, each once, as fields.
    notes: Vec<(String, String)>,
    /// Bundles rebuilt since a run was recorded, whose map that run could not use.
    stale: Vec<String>,
}

impl Symbols {
    pub fn new() -> Self {
        let cwd = std::env::current_dir()
            .map(|p| folder(&p))
            .unwrap_or_default();
        Symbols {
            funcs: Funcs::default(),
            cwd,
            roots: HashMap::new(),
            maps: HashMap::new(),
            frames: HashMap::new(),
            run_maps: HashMap::new(),
            recorded: None,
            rebuilt: HashMap::new(),
            notes: Vec::new(),
            stale: Vec::new(),
        }
    }

    /// What a reader should know about the locations shown, as fields.
    pub fn notes(&self) -> Vec<(String, String)> {
        let mut notes = self.notes.clone();
        if !self.stale.is_empty() {
            notes.push(("maps stale".to_string(), self.stale.join(", ")));
        }
        notes
    }

    /// Starts reading a run, with the maps it saved (`manifest`) and when it was recorded.
    pub fn begin_run(&mut self, manifest: Option<&Path>, recorded: Option<SystemTime>) {
        self.frames.clear();
        self.run_maps.clear();
        self.rebuilt.clear();
        self.recorded = recorded;
        let Some(manifest) = manifest else { return };
        let saved = fs::read(manifest)
            .ok()
            .and_then(|b| serde_json::from_slice::<HashMap<String, String>>(&b).ok());
        let Some(saved) = saved else {
            self.note("maps unreadable", manifest.display().to_string());
            return;
        };
        let dir = manifest.parent().unwrap_or(Path::new("."));
        for (bundle, map) in saved {
            self.run_maps
                .insert(slash(&bundle).to_lowercase(), dir.join(map));
        }
    }

    fn note(&mut self, key: &str, value: String) {
        let note = (key.to_string(), value);
        if !self.notes.contains(&note) {
            self.notes.push(note);
        }
    }

    pub fn func(&mut self, frame: &CallFrame) -> FuncId {
        let key = (
            frame.function_name.clone(),
            frame.url.clone(),
            frame.line,
            frame.column,
        );
        if let Some(&id) = self.frames.get(&key) {
            return id;
        }
        let (name, loc, kind, own) = self.resolve(frame);
        let id = self.funcs.intern(name, loc, kind, own);
        self.frames.insert(key, id);
        id
    }

    /// The function's name and location, its kind, and whether it is the app's own code.
    fn resolve(&mut self, frame: &CallFrame) -> (String, String, FuncKind, bool) {
        let special = match frame.function_name.as_str() {
            "(root)" => Some(FuncKind::Root),
            "(program)" => Some(FuncKind::Program),
            "(idle)" => Some(FuncKind::Idle),
            "(garbage collector)" => Some(FuncKind::Gc),
            _ => None,
        };
        if let Some(kind) = special {
            return (frame.function_name.clone(), String::new(), kind, false);
        }
        // A script's own code, outside any function, is a nameless function at its very start.
        let top_level = frame.function_name.is_empty() && frame.line == 0 && frame.column == 0;
        let name = if top_level {
            "(top level)".to_string()
        } else if frame.function_name.is_empty() {
            "(anonymous)".to_string()
        } else {
            frame.function_name.clone()
        };
        if frame.url.is_empty() {
            return (name, "native".to_string(), FuncKind::Native, false);
        }
        let line = frame.line + 1;
        if let Some(path) = file_path(&frame.url) {
            // The file is all there is to say: its first line maps to whichever module comes first.
            if top_level || frame.line < 0 {
                return (name, self.short(&path), FuncKind::Js, is_own(&path));
            }
            let column = frame.column.max(0) as u32;
            if let Some((source, source_line)) = self.lookup(&path, frame.line as u32, column) {
                let loc = format!("{}:{}", self.short(&source), source_line + 1);
                return (name, loc, FuncKind::Js, is_own(&source));
            }
            // A minified file puts many functions on one line: the column tells them apart.
            let column = if frame.column > 500 {
                format!(":{}", frame.column + 1)
            } else {
                String::new()
            };
            let loc = format!("{}:{line}{column}", self.short(&path));
            // A bundle's unmapped code is the bundler's, or a dependency's whose map is gone.
            let own = is_own(&path) && !self.is_bundle(&path);
            return (name, loc, FuncKind::Js, own);
        }
        // A dev server's module is the app's; `node:internal/...` and the like are the runtime's.
        let served = frame.url.starts_with("http://") || frame.url.starts_with("https://");
        let path = web_path(&frame.url);
        let own = served && is_own(&path);
        if top_level || frame.line < 0 {
            return (name, path, FuncKind::Js, own);
        }
        (name, format!("{path}:{line}"), FuncKind::Js, own)
    }

    /// The source file and 0-based line a bundle position comes from.
    fn lookup(&mut self, path: &str, line: u32, column: u32) -> Option<(String, u32)> {
        let map = match self.run_maps.get(&path.to_lowercase()) {
            Some(saved) => {
                let key = saved.to_string_lossy().into_owned();
                let saved = saved.clone();
                self.maps
                    .entry(key)
                    .or_insert_with(|| SourceMap::from_slice(&fs::read(saved).ok()?).ok())
            }
            None => {
                if self.was_rebuilt(path) {
                    return None;
                }
                self.maps
                    .entry(path.to_string())
                    .or_insert_with(|| load_map(path))
            }
        };
        let token = map.as_ref()?.lookup_token(line, column)?;
        let source = token.get_source()?;
        let dir = Path::new(path).parent()?;
        Some((normalize(&dir.join(source)), token.get_src_line()))
    }

    /// Whether a file is a bundle: it has a source map, or had one before a rebuild. Call it after
    /// `lookup`, which reads the maps.
    fn is_bundle(&self, path: &str) -> bool {
        let map = match self.run_maps.get(&path.to_lowercase()) {
            Some(saved) => self.maps.get(saved.to_string_lossy().as_ref()),
            None => self.maps.get(path),
        };
        map.is_some_and(Option::is_some) || self.rebuilt.get(path) == Some(&true)
    }

    /// Whether a bundle changed after the run was recorded: its map then shows the wrong lines.
    fn was_rebuilt(&mut self, path: &str) -> bool {
        if let Some(&known) = self.rebuilt.get(path) {
            return known;
        }
        let modified = fs::metadata(path).and_then(|m| m.modified()).ok();
        let rebuilt = matches!((modified, self.recorded), (Some(m), Some(r)) if m > r);
        self.rebuilt.insert(path.to_string(), rebuilt);
        if rebuilt {
            let bundle = self.short(path);
            if !self.stale.contains(&bundle) {
                self.stale.push(bundle);
            }
        }
        rebuilt
    }

    /// A path made short: a dependency's from its package (`react-dom/cjs/...`), else from its
    /// repository's root (`apps/desktop/src/...`), else from the folder perfq runs in.
    fn short(&mut self, path: &str) -> String {
        if let Some(i) = path.rfind("/node_modules/") {
            return path[i + "/node_modules/".len()..].to_string();
        }
        let root = self.root_of(path).unwrap_or_else(|| self.cwd.clone());
        match path.get(..root.len()) {
            Some(head) if !root.is_empty() && head.eq_ignore_ascii_case(&root) => {
                path[root.len()..].to_string()
            }
            _ => path.to_string(),
        }
    }

    fn root_of(&mut self, path: &str) -> Option<String> {
        let dir = Path::new(path).parent()?;
        let key = slash(&dir.to_string_lossy());
        self.roots
            .entry(key)
            .or_insert_with(|| {
                dir.ancestors()
                    .find(|d| d.join(".git").exists())
                    .map(folder)
            })
            .clone()
    }
}

/// A folder's path with forward slashes and a slash at the end.
fn folder(path: &Path) -> String {
    let mut s = slash(&path.to_string_lossy());
    if !s.ends_with('/') {
        s.push('/');
    }
    s
}

fn load_map(path: &str) -> Option<SourceMap> {
    let beside = fs::read(format!("{path}.map")).ok();
    let bytes = beside.or_else(|| {
        let code = fs::read_to_string(path).ok()?;
        let url = code
            .lines()
            .rev()
            .take(3)
            .find_map(|line| line.trim().strip_prefix("//# sourceMappingURL="))?;
        if url.starts_with("data:") {
            return None;
        }
        fs::read(Path::new(path).parent()?.join(url)).ok()
    })?;
    SourceMap::from_slice(&bytes).ok()
}

/// Whether a source path is the app's own code rather than a dependency's.
fn is_own(path: &str) -> bool {
    !path.starts_with("node_modules/") && !path.contains("/node_modules/")
}

/// The path a `file://` URL or a bare absolute path names, with forward slashes.
fn file_path(url: &str) -> Option<String> {
    if let Some(rest) = url.strip_prefix("file://") {
        let rest = percent_decode(rest);
        // file:///C:/x names C:/x; file:///home/x names /home/x.
        let b = rest.as_bytes();
        if b.len() > 2 && b[0] == b'/' && b[2] == b':' {
            return Some(rest[1..].to_string());
        }
        return Some(rest);
    }
    let b = url.as_bytes();
    let windows = b.len() > 2 && b[1] == b':' && (b[2] == b'/' || b[2] == b'\\');
    if url.starts_with('/') || windows {
        return Some(slash(url));
    }
    None
}

/// A web URL's path, without its origin or query: `src/app.tsx` for a dev server's module.
fn web_path(url: &str) -> String {
    let Some((_, rest)) = url.split_once("://") else {
        return url.to_string();
    };
    let path = rest.find('/').map_or("", |i| &rest[i + 1..]);
    let path = path.split(['?', '#']).next().unwrap_or(path);
    match path.rfind("node_modules/") {
        Some(i) => path[i..].to_string(),
        None => path.to_string(),
    }
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        // `get` is None past the end, and inside a character that takes more than one byte.
        if b[i] == b'%'
            && let Some(hex) = s.get(i + 1..i + 3)
            && hex.bytes().all(|c| c.is_ascii_hexdigit())
            && let Ok(v) = u8::from_str_radix(hex, 16)
        {
            out.push(v);
            i += 3;
            continue;
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn slash(s: &str) -> String {
    s.replace('\\', "/")
}

/// Resolves `.` and `..` without touching the disk.
fn normalize(path: &Path) -> String {
    let mut head = String::new();
    let mut parts: Vec<String> = Vec::new();
    for part in path.components() {
        match part {
            Component::Prefix(p) => head = p.as_os_str().to_string_lossy().into_owned(),
            Component::RootDir => head.push('/'),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop();
            }
            Component::Normal(p) => parts.push(p.to_string_lossy().into_owned()),
        }
    }
    slash(&format!("{head}{}", parts.join("/")))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_urls_name_their_paths() {
        for (url, path) in [
            ("file:///C:/My%20Code/app.js", Some("C:/My Code/app.js")),
            ("file:///home/me/caf%C3%A9.js", Some("/home/me/café.js")),
            // A % that starts no escape stays as it is, before a character of two bytes too.
            ("file:///C:/%a\u{e9}.js", Some("C:/%a\u{e9}.js")),
            ("file:///C:/100%+1.js", Some("C:/100%+1.js")),
            (r"C:\work\app.js", Some("C:/work/app.js")),
            ("http://localhost:5173/src/app.tsx", None),
        ] {
            assert_eq!(file_path(url).as_deref(), path, "{url}");
        }
    }
}
