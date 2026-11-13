import { describe, expect, test } from "vitest";
import type { ModelOption, Project } from "@dodocode/protocol";

import { carriedModel, holds, projectHolding } from "./sessions";

const project = (id: string, path: string) => ({ id, path }) as Project;

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
