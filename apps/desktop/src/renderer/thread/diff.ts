// What a diff view reads off a file's path and its hunk headers.

import type { CSSProperties } from "react";
import type { DiffLine } from "./blocks";

/** Past this many lines, a diff shows unhighlighted, so it opens without a wait. */
const HIGHLIGHT_MAX = 1500;

/** Extensions the highlighter knows by another name. */
const SAME_LANGUAGE: Record<string, string> = {
  mjs: "js",
  cjs: "js",
  mts: "ts",
  cts: "ts",
  htm: "html",
  bash: "sh",
  zsh: "sh",
};

/** The language to highlight a file as, by its extension. "text" for a file without one. */
export function languageOf(path: string): string {
  const name = path.slice(Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const dot = name.lastIndexOf(".");
  // A name that starts with its only dot, like `.env`, has no extension.
  if (dot <= 0) return "text";
  const extension = name.slice(dot + 1).toLowerCase();
  return SAME_LANGUAGE[extension] ?? extension;
}

/** A path as its folder and its file's name, so the name can stay whole as the folder is cut. */
export function splitPath(path: string): { folder: string; name: string } {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return { folder: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}

/** What git wrote after a hunk's `@@` header: the function or block the hunk is in. */
export function hunkHeading(header: string): string {
  return header.replace(/^@@[^@]*@@ ?/, "").trim();
}

/** A diff's code, laid out to highlight it as one piece, so a comment or string over several lines keeps its colour on each. */
export interface DiffSource {
  /** The code alone, a line for each of the diff's lines but its hunks. */
  code: string;
  /** Where each of the diff's lines sits among the code's lines, or -1 for a hunk. */
  at: number[];
  /** What to highlight it as. */
  language: string;
  /** Sets `--digits` wide enough for the longest number, so every row's code starts at the same place. */
  style: CSSProperties;
}

export function diffSource(lines: readonly DiffLine[], path: string): DiffSource {
  const texts: string[] = [];
  const at = lines.map((line) => (line.kind === "hunk" ? -1 : texts.push(line.text) - 1));
  let last = 1;
  for (const line of lines) last = Math.max(last, line.after ?? 0, line.before ?? 0);
  return {
    code: texts.join("\n"),
    at,
    language: lines.length > HIGHLIGHT_MAX ? "text" : languageOf(path),
    style: { "--digits": `${String(last).length}ch` } as CSSProperties,
  };
}

/** A hunk that starts the file, which leaves nothing out above it, and so doesn't show. */
export function startsFile(line: DiffLine, index: number): boolean {
  return index === 0 && line.kind === "hunk" && (line.after ?? 1) <= 1 && (line.before ?? 1) <= 1;
}
