// GitHub, as the server asks it about a branch: through the GitHub CLI the person signed in to,
// so it knows their repositories as they do. Without the CLI, or signed out, nothing is asked,
// and the app works as it does without GitHub.

import { execFile } from "node:child_process";

import type { PullRequest } from "@dodocode/protocol";

import { agentEnv } from "./providers/env";

/** How long the CLI gets to answer. */
const TIMEOUT_MS = 15_000;
/** After the CLI was missing, how long before it is looked for again. */
const MISSING_MS = 10 * 60_000;

/** Until when the CLI is taken to be missing. */
let missingUntil = 0;

interface Listed {
  number: number;
  title: string;
  url: string;
  state: string;
  isDraft?: boolean;
  baseRefName: string;
  updatedAt?: string;
}

/**
 * The pull request of a branch in the repository at `root`: the open one, else the one updated
 * last. `undefined` when it has none; `null` when GitHub could not say, as when the CLI is
 * missing or signed out, or the repository isn't on GitHub.
 */
export async function pullRequestOf(
  root: string,
  branch: string,
): Promise<PullRequest | undefined | null> {
  if (Date.now() < missingUntil) return null;
  const out = await gh(root, [
    "pr",
    "list",
    "--head",
    branch,
    "--state",
    "all",
    "--limit",
    "10",
    "--json",
    "number,title,url,state,isDraft,baseRefName,updatedAt",
  ]);
  if (out === undefined) return null;
  let listed: Listed[];
  try {
    listed = JSON.parse(out) as Listed[];
  } catch {
    return null;
  }
  if (!Array.isArray(listed) || listed.length === 0) return undefined;
  const latest = (list: Listed[]) =>
    list.toSorted((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
  const found = latest(listed.filter((pr) => pr.state === "OPEN")) ?? latest(listed);
  if (!found) return undefined;
  const state = found.state === "MERGED" ? "merged" : found.state === "OPEN" ? "open" : "closed";
  return {
    number: found.number,
    title: found.title,
    url: found.url,
    state,
    ...(found.isDraft ? { draft: true } : {}),
    base: found.baseRefName,
  };
}

/** Runs the GitHub CLI, and gives back what it printed, or nothing when it failed. */
function gh(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((done) => {
    execFile(
      "gh",
      args,
      {
        cwd,
        // Never a prompt: nobody is there to answer it.
        env: { ...agentEnv(), GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" },
        encoding: "utf8",
        timeout: TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") {
          missingUntil = Date.now() + MISSING_MS;
        }
        done(error ? undefined : stdout);
      },
    );
  });
}
