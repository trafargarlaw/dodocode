// Changing a thread's provider or model: the settings that follow from the change.

import type {
  ModelOption,
  ProviderId,
  ProviderInfo,
  Settings,
  ThreadSettings,
} from "@dodocode/protocol";

/** The effort to run a model with: the one wanted when the model takes it, else its default. */
export function effortFor(model: ModelOption | undefined, wanted: string): string {
  // A model the provider has not listed yet keeps what was asked for.
  if (!model) return wanted;
  if (model.efforts.length === 0) return "";
  if (model.efforts.includes(wanted)) return wanted;
  if (model.defaultEffort && model.efforts.includes(model.defaultEffort))
    return model.defaultEffort;
  return model.efforts[0] ?? "";
}

export function findModel(
  providers: readonly ProviderInfo[],
  provider: ProviderId,
  model: string,
): ModelOption | undefined {
  return providers.find((entry) => entry.id === provider)?.models.find((m) => m.id === model);
}

/**
 * Switches to a model, of the same agent or another. The effort stays when the model takes it;
 * going back to another agent's model takes the effort last used with that model.
 */
export function withModel(
  current: ThreadSettings,
  choice: { provider: ProviderId; model: string },
  providers: readonly ProviderInfo[],
  last: Settings["lastByProvider"] = {},
): ThreadSettings {
  const remembered = choice.provider === current.provider ? undefined : last[choice.provider];
  const wanted = remembered?.model === choice.model ? remembered.effort : current.effort;
  return {
    ...current,
    provider: choice.provider,
    model: choice.model,
    effort: effortFor(findModel(providers, choice.provider, choice.model), wanted),
  };
}

/** The effort one step lower (-1) or higher (1) than the current one, stopping at either end. */
export function stepEffort(efforts: readonly string[], current: string, step: -1 | 1): string {
  const at = efforts.indexOf(current);
  if (at < 0) return (step > 0 ? efforts[0] : efforts.at(-1)) ?? current;
  return efforts[Math.min(Math.max(at + step, 0), efforts.length - 1)] ?? current;
}

const EFFORT_LABEL: Record<string, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

export function effortLabel(effort: string): string {
  return EFFORT_LABEL[effort] ?? effort.charAt(0).toUpperCase() + effort.slice(1);
}

const EFFORT_HINT: Record<string, string> = {
  minimal: "Barely thinks before it answers. The fastest.",
  low: "Thinks briefly. Quick, for simple work.",
  medium: "Thinks a while: a balance of speed and care.",
  high: "Thinks longer, for harder problems.",
  xhigh: "Thinks a lot longer. Slower, for the hardest problems.",
  max: "Thinks as long as it needs. The slowest.",
  ultra: "Thinks the longest of all. The slowest.",
};

/** What an effort level means for how the model works, when the level is a known one. */
export function effortHint(effort: string): string | undefined {
  return EFFORT_HINT[effort];
}
