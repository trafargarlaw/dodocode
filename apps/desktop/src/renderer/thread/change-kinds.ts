// What each changed file is, so a person sees at a glance how much of the work is tests, code,
// docs or setup, and how many files are new, gone or moved, and can look at one part at a time.

import type { FileChange } from "@dodocode/protocol";

/** What a file is for. */
export type FileRole = "code" | "tests" | "docs" | "config";

export const ROLES: readonly FileRole[] = ["code", "tests", "docs", "config"];

export const ROLE_LABEL: Record<FileRole, string> = {
  code: "Code",
  tests: "Tests",
  docs: "Docs",
  config: "Config",
};

const TEST_FOLDER = /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|testdata|fixtures)\//i;
const TEST_FILE = /[._](test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/i;
const DOC_FOLDER = /(^|\/)docs?\//i;
const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const DOC_NAME = /^(readme|changelog|license|licence|contributing|authors|notice)(\.|$)/i;
/** Lockfiles, and files named for the tool they set up, whatever their extension. */
const SETUP_NAME =
  /(^|[.-])lock(\.(ya?ml|json)|b?$)|^go\.sum$|^requirements[^/]*\.txt$|^(dockerfile|makefile|justfile|procfile)$|^tsconfig[^/]*$|\.config\.[cm]?[jt]s$/i;
const CONFIG_FILE = /\.(json|jsonc|json5|ya?ml|toml|ini|cfg|conf|env|properties)$/i;

/** What a file is for, from where it is and what it's called. */
export function roleOf(path: string): FileRole {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (TEST_FOLDER.test(path) || TEST_FILE.test(path)) return "tests";
  if (SETUP_NAME.test(name)) return "config";
  if (DOC_FOLDER.test(path) || DOC_FILE.test(name) || DOC_NAME.test(name)) return "docs";
  if (name.startsWith(".") || CONFIG_FILE.test(name)) return "config";
  return "code";
}

/** How many files of one sort changed, and their lines. */
export interface Tally {
  files: number;
  added: number;
  removed: number;
}

export interface Breakdown {
  roles: Record<FileRole, Tally>;
  /** Files that are new, gone, or under another name. */
  added: number;
  deleted: number;
  moved: number;
}

function tally(): Tally {
  return { files: 0, added: 0, removed: 0 };
}

/** How the changed files split by what they're for, and how many are new, gone or moved. */
export function breakdown(
  files: readonly { change: FileChange; added: number; removed: number }[],
): Breakdown {
  const result: Breakdown = {
    roles: { code: tally(), tests: tally(), docs: tally(), config: tally() },
    added: 0,
    deleted: 0,
    moved: 0,
  };
  for (const { change, added, removed } of files) {
    const role = result.roles[roleOf(change.movedTo ?? change.path)];
    role.files += 1;
    role.added += added;
    role.removed += removed;
    if (change.kind === "add") result.added += 1;
    else if (change.kind === "delete") result.deleted += 1;
    else if (change.kind === "move") result.moved += 1;
  }
  return result;
}
