// Where a conversation brought in from another app belongs, and what it carries on with.

import { isAbsolute, relative, resolve } from "node:path";

import type { ModelOption, Project } from "@dodocode/protocol";

/** Whether `path` is `folder` or inside it. */
export function holds(folder: string, path: string, platform = process.platform): boolean {
  const fold = (value: string) => (platform === "win32" ? value.toLowerCase() : value);
  const inside = relative(fold(resolve(folder)), fold(resolve(path)));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
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
