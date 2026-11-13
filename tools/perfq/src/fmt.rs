// Number formats and plain-text tables, kept narrow so a table reads at a glance.

/// A duration in microseconds, as milliseconds with the digits that matter.
pub fn ms(us: f64) -> String {
    let v = us / 1000.0;
    let a = v.abs();
    if a >= 10_000.0 {
        format!("{:.1}s", v / 1000.0)
    } else if a >= 100.0 {
        format!("{v:.0}ms")
    } else if a >= 10.0 {
        format!("{v:.1}ms")
    } else {
        format!("{v:.2}ms")
    }
}

/// Like `ms`, but `-` for nothing, so a table's empty cells stand out.
pub fn cell_ms(us: f64) -> String {
    if us.abs() < 5.0 {
        "-".to_string()
    } else {
        ms(us)
    }
}

pub fn signed_ms(us: f64) -> String {
    if us >= 0.0 {
        format!("+{}", ms(us))
    } else {
        format!("-{}", ms(-us))
    }
}

pub fn pct(part: f64, whole: f64) -> String {
    if whole <= 0.0 {
        return "-".to_string();
    }
    format!("{:.1}%", part / whole * 100.0)
}

pub fn signed_pct(part: f64, whole: f64) -> String {
    if whole <= 0.0 {
        return String::new();
    }
    format!("{:+.0}%", part / whole * 100.0)
}

/// A moment, as seconds into the run.
pub fn at(us: f64) -> String {
    format!("{:.3}s", us / 1e6)
}

/// A run's length.
pub fn seconds(us: f64) -> String {
    format!("{:.1}s", us / 1e6)
}

/// A command line argument, quoted when a shell would split or expand it.
pub fn arg(text: &str) -> String {
    let text = slashes(text);
    let plain = !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-./:@+=,".contains(c));
    if plain {
        text
    } else {
        format!("'{}'", text.replace('\'', "'\\''"))
    }
}

/// A path with forward slashes, one between names: pnpm on Windows passes each backslash on
/// doubled. A network path keeps its leading two.
fn slashes(path: &str) -> String {
    let path = path.replace('\\', "/");
    let mut out = String::new();
    for c in path.chars() {
        if !(c == '/' && out.ends_with('/')) {
            out.push(c);
        }
    }
    if path.starts_with("//") {
        out.insert(0, '/');
    }
    out
}

pub struct Table {
    right: Vec<bool>,
    rows: Vec<Vec<String>>,
}

impl Table {
    /// Columns are `(header, right-aligned)`.
    pub fn new(columns: &[(&str, bool)]) -> Self {
        let header = columns.iter().map(|c| c.0.to_string()).collect();
        Table {
            right: columns.iter().map(|c| c.1).collect(),
            rows: vec![header],
        }
    }

    pub fn row(&mut self, cells: Vec<String>) {
        self.rows.push(cells);
    }

    pub fn render(&self) -> String {
        let mut widths = vec![0; self.right.len()];
        for row in &self.rows {
            for (i, cell) in row.iter().enumerate() {
                widths[i] = widths[i].max(cell.chars().count());
            }
        }
        let mut out = String::new();
        for row in &self.rows {
            let mut line = String::new();
            for (i, cell) in row.iter().enumerate() {
                if i > 0 {
                    line.push_str("  ");
                }
                let pad = " ".repeat(widths[i] - cell.chars().count());
                if self.right[i] {
                    line.push_str(&pad);
                    line.push_str(cell);
                } else {
                    line.push_str(cell);
                    line.push_str(&pad);
                }
            }
            out.push_str(line.trim_end());
            out.push('\n');
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::arg;

    #[test]
    fn paths_print_as_a_shell_takes_them() {
        // As pnpm on Windows passes them on.
        assert_eq!(
            arg(r"C:\\Users\\me\\run.trace.json"),
            "C:/Users/me/run.trace.json"
        );
        assert_eq!(arg(r"\\\\host\\share\\run"), "//host/share/run");
        assert_eq!(arg(r"\\host\share\run"), "//host/share/run");
        assert_eq!(arg(r"traces\a b"), "'traces/a b'");
    }
}
