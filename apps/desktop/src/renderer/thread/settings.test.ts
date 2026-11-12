import { describe, expect, test } from "vitest";
import type { ModelOption, ProviderInfo, ThreadSettings } from "@dodocode/protocol";
import { effortFor, withModel, withProvider } from "./settings";

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

describe("withProvider", () => {
  test.each<
    [
      string,
      ThreadSettings["provider"],
      Parameters<typeof withProvider>[3],
      Partial<ThreadSettings>,
    ]
  >([
    [
      "goes back to the model and effort last used",
      "codex",
      { codex: { model: "gpt-b", effort: "minimal" } },
      { provider: "codex", model: "gpt-b", effort: "minimal" },
    ],
    [
      "takes the first model when the one last used is gone",
      "codex",
      { codex: { model: "retired", effort: "high" } },
      { provider: "codex", model: "gpt-a", effort: "high" },
    ],
    [
      "takes the first model and its default effort with nothing remembered",
      "codex",
      {},
      { provider: "codex", model: "gpt-a", effort: "medium" },
    ],
  ])("%s", (_name, provider, last, expected) => {
    expect(withProvider(onOpus, provider, providers, last)).toEqual({ ...onOpus, ...expected });
  });

  test("keeps the remembered model of a provider that hasn't listed its models", () => {
    const unlisted = providers.map((entry) =>
      entry.id === "codex" ? { ...entry, models: [] } : entry,
    );
    expect(
      withProvider(onOpus, "codex", unlisted, { codex: { model: "gpt-b", effort: "low" } }),
    ).toEqual({
      ...onOpus,
      provider: "codex",
      model: "gpt-b",
      effort: "low",
    });
  });
});

describe("withModel", () => {
  test.each<[string, ThreadSettings, string, string]>([
    [
      "keeps an effort the new model takes",
      { ...onOpus, provider: "codex", model: "gpt-a", effort: "low" },
      "gpt-b",
      "low",
    ],
    ["drops the effort for a model that takes none", onOpus, "haiku", ""],
    [
      "falls back to the new model's default",
      { ...onOpus, provider: "codex", model: "gpt-b", effort: "minimal" },
      "gpt-a",
      "medium",
    ],
  ])("%s", (_name, current, next, effort) => {
    expect(withModel(current, next, providers)).toEqual({ ...current, model: next, effort });
  });
});
