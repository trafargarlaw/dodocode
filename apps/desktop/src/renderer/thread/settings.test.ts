import { describe, expect, test } from "vitest";
import type { ModelOption, ProviderInfo, ThreadSettings } from "@dodocode/protocol";
import { effortFor, stepEffort, withModel } from "./settings";

function model(id: string, efforts: string[], defaultEffort?: string): ModelOption {
  return { id, label: id, efforts, defaultEffort };
}

const providers: ProviderInfo[] = [
  {
    id: "claude",
    label: "Claude",
    status: "ready",
    models: [model("opus", ["low", "medium", "high", "max"], "high"), model("haiku", [])],
  },
  {
    id: "codex",
    label: "Codex",
    status: "ready",
    models: [
      model("gpt-a", ["low", "medium", "high"], "medium"),
      model("gpt-b", ["minimal", "low"]),
    ],
  },
];

const onOpus: ThreadSettings = {
  provider: "claude",
  model: "opus",
  effort: "max",
  access: "supervised",
};

describe("effortFor", () => {
  test.each<[string, ModelOption | undefined, string, string]>([
    ["keeps the effort for a model not listed yet", undefined, "high", "high"],
    ["drops the effort for a model that takes none", model("m", []), "high", ""],
    ["keeps an effort the model takes", model("m", ["low", "high"]), "high", "high"],
    ["falls back to the model's default", model("m", ["low", "medium"], "medium"), "max", "medium"],
    [
      "falls back to the first when the default isn't offered",
      model("m", ["low", "high"], "max"),
      "max",
      "low",
    ],
  ])("%s", (_name, option, wanted, expected) => {
    expect(effortFor(option, wanted)).toBe(expected);
  });
});

describe("withModel", () => {
  test.each<
    [
      string,
      ThreadSettings,
      { provider: ThreadSettings["provider"]; model: string },
      Parameters<typeof withModel>[3],
      string,
    ]
  >([
    [
      "keeps an effort the new model takes",
      { ...onOpus, provider: "codex", model: "gpt-a", effort: "low" },
      { provider: "codex", model: "gpt-b" },
      {},
      "low",
    ],
    [
      "drops the effort for a model that takes none",
      onOpus,
      { provider: "claude", model: "haiku" },
      {},
      "",
    ],
    [
      "falls back to the new model's default",
      { ...onOpus, provider: "codex", model: "gpt-b", effort: "minimal" },
      { provider: "codex", model: "gpt-a" },
      {},
      "medium",
    ],
    [
      "keeps the effort across agents when the other agent's model takes it",
      { ...onOpus, effort: "high" },
      { provider: "codex", model: "gpt-a" },
      {},
      "high",
    ],
    [
      "goes back to the effort last used with another agent's model",
      onOpus,
      { provider: "codex", model: "gpt-a" },
      { codex: { model: "gpt-a", effort: "low" } },
      "low",
    ],
    [
      "uses a remembered effort only for the model it was used with",
      onOpus,
      { provider: "codex", model: "gpt-a" },
      { codex: { model: "gpt-b", effort: "minimal" } },
      "medium",
    ],
    [
      "ignores what was remembered for the agent already in use",
      { ...onOpus, effort: "low" },
      { provider: "claude", model: "opus" },
      { claude: { model: "opus", effort: "max" } },
      "low",
    ],
  ])("%s", (_name, current, choice, last, effort) => {
    expect(withModel(current, choice, providers, last)).toEqual({ ...current, ...choice, effort });
  });
});

describe("stepEffort", () => {
  const levels = ["low", "medium", "high"];
  test.each<[string, string, -1 | 1, string]>([
    ["steps up", "medium", 1, "high"],
    ["steps down", "medium", -1, "low"],
    ["stops at the top", "high", 1, "high"],
    ["stops at the bottom", "low", -1, "low"],
    ["starts from the bottom going up from a level the model lacks", "max", 1, "low"],
    ["starts from the top going down from a level the model lacks", "", -1, "high"],
  ])("%s", (_name, current, step, expected) => {
    expect(stepEffort(levels, current, step)).toBe(expected);
  });
});
