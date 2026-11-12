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
 * Switches to another provider, back to the model and effort last used with it when it still
 * offers that model, else to its first model.
 */
export function withProvider(
  current: ThreadSettings,
  provider: ProviderId,
  providers: readonly ProviderInfo[],
  last: Settings["lastByProvider"],
): ThreadSettings {
  if (provider === current.provider) return current;
  const models = providers.find((entry) => entry.id === provider)?.models ?? [];
  const remembered = last[provider];
  const model = models.find((entry) => entry.id === remembered?.model) ?? models[0];
  return {
    ...current,
    provider,
    model: model?.id ?? remembered?.model ?? "",
    effort: effortFor(model, remembered?.effort ?? current.effort),
  };
}

/** Switches model, keeping the effort when the new model takes it. */
export function withModel(
  current: ThreadSettings,
  model: string,
  providers: readonly ProviderInfo[],
): ThreadSettings {
  return {
    ...current,
    model,
    effort: effortFor(findModel(providers, current.provider, model), current.effort),
  };
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
