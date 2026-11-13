import { describe, expect, test } from "vitest";
import type { ModelOption, Project } from "@dodocode/protocol";

import { carriedModel, holds, placeFor, projectHolding, type Placing } from "./sessions";

const project = (id: string, path: string) => ({ id, path }) as Project;

/** Where a conversation goes, in a word: none, a project's id, or the folder added. */
const named = (placing: Placing) =>
  !placing ? "none" : "project" in placing ? placing.project.id : `add ${placing.add}`;

const option = (id: string): ModelOption => ({
  id,
  label: id,
  efforts: ["low", "high", "max"],
  defaultEffort: "high",
});

describe("where a conversation goes", () => {
  test.each([
    { folder: "/work/app", path: "/work/app", held: true },
    { folder: "/work/app", path: "/work/app/src/parse", held: true },
    // A sibling whose name starts the same.
    { folder: "/work/app", path: "/work/apple", held: false },
    { folder: "/work/app/src", path: "/work/app", held: false },
    // Windows paths differ in case only.
    { folder: "/Work/App", path: "/work/app/src", held: true },
  ])("$folder holds $path: $held", ({ folder, path, held }) => {
    expect(holds(folder, path, "win32")).toBe(held);
  });

  test("a folder goes in the nearest project that holds it, and outside them all in none", () => {
    // The outer one listed first, so taking the first that holds the folder picks wrong.
    const projects = [project("outer", "/work"), project("inner", "/work/app")];

    expect(projectHolding(projects, "/work/app/src")?.id).toBe("inner");
    expect(projectHolding(projects, "/work/notes")?.id).toBe("outer");
    expect(projectHolding(projects, "/elsewhere")).toBeUndefined();
  });

  // As another app makes them: Codex's and T3 Code's worktrees are in the home folder.
  const home = project("home", "/home/me");
  const app = project("app", "/home/me/code/app");
  const web = project("web", "/home/me/code/mono/apps/web");

  test.each([
    {
      case: "the home folder, outside any repository",
      projects: [],
      cwd: "/home/me",
      checkout: undefined,
      goes: "none",
    },
    {
      case: "a folder in the home folder, outside any repository",
      projects: [],
      cwd: "/home/me/notes",
      checkout: undefined,
      goes: "add /home/me/notes",
    },
    {
      case: "a repository whose checkout is the home folder",
      projects: [],
      cwd: "/home/me/.config",
      checkout: { root: "/home/me", main: "/home/me" },
      goes: "none",
    },
    {
      case: "a drive's root",
      projects: [],
      cwd: "/",
      checkout: undefined,
      goes: "none",
    },
    {
      case: "another app's worktree, with the home folder a project too",
      projects: [home, app],
      cwd: "/home/me/.codex/worktrees/ab12/app/src",
      checkout: { root: "/home/me/.codex/worktrees/ab12/app", main: "/home/me/code/app" },
      goes: "app",
    },
    {
      case: "another app's worktree of a repository whose project is a folder in it",
      projects: [web],
      cwd: "/home/me/.t3/worktrees/mono/x/apps/web",
      checkout: { root: "/home/me/.t3/worktrees/mono/x", main: "/home/me/code/mono" },
      goes: "web",
    },
    {
      case: "a folder in a repository no project holds",
      projects: [home],
      cwd: "/home/me/code/new/src",
      checkout: { root: "/home/me/code/new", main: "/home/me/code/new" },
      goes: "home",
    },
    {
      case: "a folder in a repository, with no project",
      projects: [],
      cwd: "/home/me/code/new/src",
      checkout: { root: "/home/me/code/new", main: "/home/me/code/new" },
      goes: "add /home/me/code/new",
    },
  ])("$case: $goes", ({ projects, cwd, checkout, goes }) => {
    expect(named(placeFor(projects, cwd, checkout, "/home/me", "win32"))).toBe(goes);
  });
});

describe("the model a conversation carries on with", () => {
  // As Claude Code lists them: by family, with a variant in brackets.
  const claude = [option("default"), option("opus[1m]"), option("opus"), option("sonnet")];

  test.each([
    { model: "opus", effort: "max", carried: { model: "opus", effort: "max" } },
    // The family's own entry, not its variant listed before it.
    { model: "claude-opus-5-5", effort: "low", carried: { model: "opus", effort: "low" } },
    // An effort the model does not take falls back to its default.
    { model: "claude-sonnet-5-5", effort: "xhigh", carried: { model: "sonnet", effort: "high" } },
    { model: "gpt-5.5-codex", effort: "high", carried: undefined },
  ])("$model at $effort", ({ model, effort, carried }) => {
    expect(carriedModel(claude, model, effort)).toEqual(carried);
  });

  test("a family offered only as a variant carries on as that variant", () => {
    expect(carriedModel([option("opus[1m]")], "claude-opus-5-5", "high")).toEqual({
      model: "opus[1m]",
      effort: "high",
    });
  });
});
