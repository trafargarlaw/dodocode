// Where a conversation brought in from another app belongs, and what it carries on with.

import { homedir } from "node:os";
import { isAbsolute, join, parse, relative, resolve } from "node:path";

import type { ModelOption, Project } from "@dodocode/protocol";

/** Whether `path` is `folder` or inside it. */
export function holds(folder: string, path: string, platform = process.platform): boolean {
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const inside = relative(fold(resolve(folder)), fold(resolve(path)));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** Whether two paths name the same folder. */
export function samePath(a: string, b: string, platform = process.platform): boolean {
  return holds(a, b, platform) && holds(b, a, platform);
}

/** The project a folder is in: the one nearest it, when one project holds another. */
export function projectHolding(
  projects: Iterable<Project>,
  path: string,
  platform = process.platform,
): Project | undefined {
  let found: Project | undefined;
  for (const project of projects) {
    if (!holds(project.path, path, platform)) continue;
    if (!found || holds(found.path, project.path, platform)) found = project;
  }
  return found;
}

/** What git says of the folder a conversation worked in, when a repository holds it. */
export interface Checkout {
  /** The checkout's top folder. */
  root: string;
  /** The repository's main checkout: `root`, unless the folder is in a worktree. */
  main: string;
}

/** Where a conversation goes: in a project there is, in a folder added as one, or in none. */
export type Placing = { project: Project } | { add: string } | undefined;

/**
 * The project a conversation goes in, by the folder it worked in:
 * 1. the nearest project in the same checkout that holds the folder;
 * 2. in a worktree, the project that holds the same folder in the main checkout, so another
 *    app's worktree goes with its repository's project;
 * 3. the nearest project that holds the folder from outside its checkout;
 * 4. otherwise a new project: the repository's main checkout or, outside one, the folder.
 *    Never the home folder, a folder that holds it, or a drive's root. Those hold so much that
 *    every conversation after would go in them.
 */
export function placeFor(
  projects: readonly Project[],
  cwd: string,
  checkout: Checkout | undefined,
  home = homedir(),
  platform = process.platform,
): Placing {
  const inside = (folder: string, path: string) =>
    projectHolding(
      projects.filter((project) => holds(folder, project.path, platform)),
      path,
      platform,
    );
  const found =
    (checkout && inside(checkout.root, cwd)) ??
    (checkout && inside(checkout.main, join(checkout.main, relative(checkout.root, cwd)))) ??
    projectHolding(projects, cwd, platform);
  if (found) return { project: found };
  const folder = checkout?.main ?? cwd;
  const root = parse(resolve(folder)).root === resolve(folder);
  return root || holds(folder, home, platform) ? undefined : { add: folder };
}

/**
 * The model to carry on with, from the one the conversation ran with last: the same, or the
 * provider's model of that family, as `claude-opus-5-5` is Claude Code's `opus`. Unset when the
 * provider has none like it.
 */
export function carriedModel(
  models: readonly ModelOption[],
  model: string | undefined,
  effort: string | undefined,
): { model: string; effort: string } | undefined {
  if (!model) return undefined;
  const words = new Set(model.toLowerCase().split(/[^a-z0-9]+/));
  const option =
    models.find((entry) => entry.id === model) ??
    models.find((entry) => !entry.id.includes("[") && words.has(entry.id.toLowerCase())) ??
    models.find((entry) => words.has(entry.id.toLowerCase().replace(/\[.*$/, "")));
  if (!option) return undefined;
  const kept = effort && option.efforts.includes(effort) ? effort : undefined;
  return { model: option.id, effort: kept ?? option.defaultEffort ?? "" };
}
