// Git, as the server uses it: what a project's folder has checked out, worktrees for threads that
// work apart from it, what their work changed, and merging it back.

import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { ChangeCount, FileChange } from "@dodocode/protocol";

import { agentEnv } from "./providers/env";

/** The tree of a commit with no files, for diffs in a repository with no commits yet. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** How much diff text one call returns, so a huge change can't swamp the window. */
const DIFF_LIMIT = 1_500_000;
/** The largest new file whose lines are shown, and how many new files are read. */
const NEW_FILE_LIMIT = 256 * 1024;
const NEW_FILES_READ = 200;

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}

function run(cwd: string, args: string[]): Promise<Run> {
  return new Promise((done, fail) => {
    execFile(
      "git",
      // Paths come back as they are, and diffs in the usual shape, whatever the person's config.
      ["-c", "core.quotePath=false", ...args],
      {
        cwd,
        env: { ...agentEnv(), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === "ENOENT") {
          fail(new Error("Git is not installed, or it is not on the PATH."));
          return;
        }
        done({ stdout, stderr, code: error ? (typeof code === "number" ? code : 1) : 0 });
      },
    );
  });
}

/** Runs git and gives back what it printed, or throws with what it said went wrong. */
async function git(cwd: string, args: string[]): Promise<string> {
  const result = await run(cwd, args);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed.`);
  }
  return result.stdout;
}

export interface Repo {
  /** The checkout's top folder. */
  root: string;
  /** Where git keeps the checkout's state. */
  gitDir: string;
  /** Where the folder asked about is inside the checkout, such as `apps/web/`. Empty at the top. */
  prefix: string;
  /** The branch checked out, or unset for a detached HEAD. */
  branch?: string;
  /** The commit checked out, or unset in a repository with no commits yet. */
  head?: string;
}

/** The repository a folder is in, or nothing when it isn't in one. */
export async function repoOf(folder: string): Promise<Repo | undefined> {
  if (!existsSync(folder)) return undefined;
  // One git asks it all: on Windows, starting a process holds up the server for several
  // milliseconds, and the server asks this of every project as it starts. The commit comes
  // before `--abbrev-ref`, which names the branch for every HEAD after it, or prints HEAD when
  // none is checked out.
  const where = await run(folder, [
    "rev-parse",
    "--show-toplevel",
    "--absolute-git-dir",
    "--show-prefix",
    "HEAD",
    "--abbrev-ref",
    "HEAD",
  ]);
  const [root = "", gitDir = "", prefix = "", head = "", ref = ""] = where.stdout.split(/\r?\n/);
  // Outside a repository git prints nothing. In one with no commits yet, it prints the folders
  // and then fails on HEAD, and only `symbolic-ref` can name the branch.
  if (!root || !gitDir) return undefined;
  const repo: Repo = { root: resolve(root), gitDir: resolve(gitDir), prefix };
  if (where.code !== 0) {
    const branch = await run(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (branch.code === 0 && branch.stdout.trim()) repo.branch = branch.stdout.trim();
    return repo;
  }
  if (ref && ref !== "HEAD") repo.branch = ref;
  if (head) repo.head = head;
  return repo;
}

/** The branches a repository has. */
export async function branches(folder: string): Promise<Set<string>> {
  const out = await git(folder, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return new Set(out.split(/\r?\n/).filter(Boolean));
}

/**
 * A branch name made from a thread's title: lowercase words joined by dashes, cut at a word
 * near 40 characters, with a number added when `taken` says the name is in use.
 */
export function branchName(title: string, taken: (name: string) => boolean): string {
  const words = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  let slug = "";
  for (const word of words) {
    const next = slug ? `${slug}-${word}` : word;
    if (next.length > 40) {
      if (!slug) slug = word.slice(0, 40);
      break;
    }
    slug = next;
  }
  const base = slug || "work";
  let name = base;
  for (let n = 2; taken(name); n += 1) name = `${base}-${n}`;
  return name;
}

/** Makes a worktree at `path` on a new branch, from what `folder` has checked out. */
export async function addWorktree(folder: string, path: string, branch: string): Promise<void> {
  await git(folder, ["worktree", "add", "-b", branch, path, "HEAD"]);
}

/** Makes a worktree at `path` again, on its branch, after its folder went missing. */
export async function restoreWorktree(folder: string, path: string, branch: string): Promise<void> {
  await run(folder, ["worktree", "prune"]);
  await git(folder, ["worktree", "add", path, branch]);
}

/** Removes a worktree's folder and git's record of it. Its branch stays. */
export async function removeWorktree(folder: string, path: string): Promise<void> {
  const removed = await run(folder, ["worktree", "remove", "--force", path]);
  if (removed.code === 0) return;
  // Git refuses when the folder is half gone or in use. On Windows a process that just ended
  // can hold its folder for a moment, so the removal tries again for a few seconds.
  await rm(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  await run(folder, ["worktree", "prune"]);
}

/** Whether a checkout has changes that aren't committed, new files included. */
export async function hasChanges(folder: string): Promise<boolean> {
  return (await git(folder, ["status", "--porcelain"])).trim().length > 0;
}

/**
 * Starts a repository in a folder, with an empty first commit so a worktree has something to
 * branch from. Without a name and email set for git, there is no commit, and that's all.
 */
export async function initRepo(folder: string): Promise<{ committed: boolean }> {
  await git(folder, ["init", "--quiet"]);
  const commit = await run(folder, ["commit", "--quiet", "--allow-empty", "-m", "Initial commit"]);
  return { committed: commit.code === 0 };
}

/** Clones a repository into `target`, a folder that must not exist yet. */
export async function cloneRepo(url: string, target: string): Promise<void> {
  // `--` keeps a URL that starts with a dash from being read as an option.
  await git(dirname(target), ["clone", "--quiet", "--", url, target]);
}

/** Commits everything that changed in a checkout. Returns whether there was anything. */
export async function commitAll(folder: string, message: string): Promise<boolean> {
  if (!(await hasChanges(folder))) return false;
  await git(folder, ["add", "--all"]);
  await git(folder, ["commit", "--quiet", "-m", message]);
  return true;
}

/**
 * Merges `branch` into what `folder` has checked out. When it conflicts, the merge is taken back
 * so the folder is as it was, and the files that conflicted come back.
 */
export async function mergeBranch(
  folder: string,
  branch: string,
): Promise<{ merged: true } | { merged: false; conflicts: string[] }> {
  const result = await run(folder, ["merge", "--no-edit", branch]);
  if (result.code === 0) return { merged: true };
  const unmerged = await run(folder, ["diff", "--name-only", "--diff-filter=U"]);
  const conflicts = unmerged.stdout.split(/\r?\n/).filter(Boolean);
  if (conflicts.length === 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "The merge failed.");
  }
  await run(folder, ["merge", "--abort"]);
  return { merged: false, conflicts };
}

/** Deletes a branch that was merged. Leaves one that wasn't. */
export async function deleteBranch(folder: string, branch: string): Promise<void> {
  await git(folder, ["branch", "-d", branch]);
}

/** The commit a checkout's changes are counted from: where it left `base`, or its own HEAD. */
async function startOf(folder: string, base: string | undefined): Promise<string> {
  if (base) {
    const fork = await run(folder, ["merge-base", base, "HEAD"]);
    if (fork.code === 0 && fork.stdout.trim()) return fork.stdout.trim();
  }
  const head = await run(folder, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return head.code === 0 && head.stdout.trim() ? head.stdout.trim() : EMPTY_TREE;
}

/** Files git doesn't track yet, and doesn't ignore. */
async function newFiles(folder: string): Promise<string[]> {
  const out = await git(folder, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return out.split("\0").filter(Boolean);
}

/** A new file's text, or nothing when it is large or not text. */
function readNew(folder: string, path: string): string | undefined {
  try {
    const full = join(folder, path);
    if (statSync(full).size > NEW_FILE_LIMIT) return undefined;
    const text = readFileSync(full, "utf8");
    return text.includes("\0") ? undefined : text;
  } catch {
    return undefined;
  }
}

/**
 * What changed in a checkout since it left `base` (or since its last commit, without one):
 * commits, edits not yet committed, and new files.
 */
export async function changesIn(
  folder: string,
  base: string | undefined,
): Promise<{ files: FileChange[]; truncated: boolean }> {
  const start = await startOf(folder, base);
  const diff = await git(folder, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--find-renames",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    start,
  ]);
  const files = parseDiff(diff);
  const added = await newFiles(folder);
  let size = 0;
  let truncated = false;
  const shown = files.map((file) => {
    size += file.diff?.length ?? 0;
    if (size <= DIFF_LIMIT) return file;
    truncated = true;
    return { ...file, diff: undefined };
  });
  added.forEach((path, index) => {
    const text = index < NEW_FILES_READ ? readNew(folder, path) : undefined;
    const hunks = text === undefined ? undefined : addedDiff(text);
    size += hunks?.length ?? 0;
    if (size > DIFF_LIMIT) truncated = true;
    shown.push({ path, kind: "add", ...(hunks && size <= DIFF_LIMIT ? { diff: hunks } : {}) });
  });
  return { files: shown, truncated };
}

/** How much changed in a checkout since it left `base`, new files included. */
export async function countChanges(folder: string, base: string | undefined): Promise<ChangeCount> {
  const start = await startOf(folder, base);
  const out = await git(folder, ["diff", "--numstat", "--find-renames", start]);
  const count = { files: 0, added: 0, removed: 0 };
  for (const line of out.split(/\r?\n/)) {
    const [plus, minus] = line.split("\t");
    if (plus === undefined || minus === undefined) continue;
    count.files += 1;
    // Binary files count as a file, with no lines.
    count.added += Number(plus) || 0;
    count.removed += Number(minus) || 0;
  }
  const added = await newFiles(folder);
  added.forEach((path, index) => {
    count.files += 1;
    const text = index < NEW_FILES_READ ? readNew(folder, path) : undefined;
    if (text) count.added += lineCount(text);
  });
  return count;
}

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/** A new file's text as a diff that adds every line. */
export function addedDiff(text: string): string {
  if (!text) return "";
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  return `@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => `+${line}`).join("\n")}\n`;
}

/** Splits `git diff` output into one change per file, each with its part of the diff. */
export function parseDiff(text: string): FileChange[] {
  const changes: FileChange[] = [];
  const parts = text.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git "));
  for (const part of parts) {
    const lines = part.split("\n");
    let kind: FileChange["kind"] = "update";
    let from: string | undefined;
    let to: string | undefined;
    let renamedFrom: string | undefined;
    let renamedTo: string | undefined;
    for (const line of lines.slice(1)) {
      if (line.startsWith("@@")) break;
      if (line.startsWith("new file mode")) kind = "add";
      else if (line.startsWith("deleted file mode")) kind = "delete";
      else if (line.startsWith("rename from ")) renamedFrom = line.slice("rename from ".length);
      else if (line.startsWith("rename to ")) renamedTo = line.slice("rename to ".length);
      else if (line.startsWith("--- ")) from = diffPath(line.slice(4), "a/");
      else if (line.startsWith("+++ ")) to = diffPath(line.slice(4), "b/");
    }
    const header = headerPath(lines[0]!.slice("diff --git ".length));
    const hunks = part.indexOf("\n@@");
    const diff = hunks === -1 ? undefined : part.slice(hunks + 1);
    if (renamedFrom !== undefined && renamedTo !== undefined) {
      changes.push({
        path: renamedFrom,
        kind: "move",
        movedTo: renamedTo,
        ...(diff ? { diff } : {}),
      });
      continue;
    }
    const path = (kind === "delete" ? from : to) ?? to ?? from ?? header;
    if (path) changes.push({ path, kind, ...(diff ? { diff } : {}) });
  }
  return changes;
}

/** The path in a `---` or `+++` line, or nothing for `/dev/null`. */
function diffPath(raw: string, prefix: string): string | undefined {
  const path = unquote(raw.replace(/\t$/, ""));
  if (path === "/dev/null") return undefined;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** The path in a `diff --git a/x b/x` line, when both sides name the same file. */
function headerPath(rest: string): string | undefined {
  const half = (rest.length - 1) / 2;
  if (!Number.isInteger(half)) return undefined;
  const a = rest.slice(0, half);
  const b = rest.slice(half + 1);
  return a.startsWith("a/") && b.startsWith("b/") && a.slice(2) === b.slice(2)
    ? unquote(a.slice(2))
    : undefined;
}

function unquote(path: string): string {
  return path.length > 1 && path.startsWith('"') && path.endsWith('"') ? path.slice(1, -1) : path;
}
