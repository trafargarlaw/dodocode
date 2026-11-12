// The agent a thread runs with: which agent, its model, and how hard that model thinks. The
// agents down the side, the models of the one looked at beside them, and the thinking level under
// both. A search finds a model of any agent.

import { useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import type { ModelOption, ProviderId, ProviderInfo, ThreadSettings } from "@dodocode/protocol";
import {
  Brain02Icon,
  ChatGptIcon,
  ClaudeIcon,
  Search01Icon,
  UnfoldMoreIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Command as CommandPrimitive } from "cmdk";
import { Button } from "@dodocode/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@dodocode/ui/components/command";
import { Popover, PopoverContent, PopoverTrigger } from "@dodocode/ui/components/popover";
import { Spinner } from "@dodocode/ui/components/spinner";
import { cn } from "@dodocode/ui/lib/utils";
import { KeyHint, PaletteFooter } from "../palette/chrome";
import { searchScore } from "../search-match";
import { reportError, settings as settingsRows } from "../server/app-data";
import { server } from "../server/connection";
import { effortHint, effortLabel, findModel, stepEffort, withModel } from "./settings";

const AGENT_ICON: Record<ProviderId, typeof ClaudeIcon> = {
  claude: ClaudeIcon,
  codex: ChatGptIcon,
};

function AgentIcon({ provider, className }: { provider: ProviderId; className?: string }) {
  return <HugeiconsIcon icon={AGENT_ICON[provider]} strokeWidth={1.8} className={className} />;
}

/** An agent whose models can be picked: it is installed and started, and has listed them. */
function usable(provider: ProviderInfo): boolean {
  return provider.status !== "missing" && provider.status !== "error" && provider.models.length > 0;
}

const keyOf = (provider: ProviderId, model: string) => `${provider}/${model}`;

// A click on these leaves the keys with the search, so the arrows keep working after it.
const keepFocus = (event: MouseEvent) => event.preventDefault();

/** The model a thread runs with and how hard it thinks, shown as one name. Opens the picker. */
export function ModelPicker({
  settings,
  providers,
  onChange,
}: {
  settings: ThreadSettings;
  providers: ProviderInfo[];
  onChange: (settings: ThreadSettings) => void;
}) {
  const [open, setOpen] = useState(false);
  const provider = providers.find((entry) => entry.id === settings.provider);
  const model = findModel(providers, settings.provider, settings.model);
  // Until the provider lists its models, the one asked for still shows by its id.
  const modelLabel = model?.label ?? (settings.model || provider?.label || settings.provider);
  const effort = settings.effort ? effortLabel(settings.effort) : undefined;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            aria-label={`Model: ${[modelLabel, effort].filter(Boolean).join(", ")}`}
            className="h-7 max-w-60 min-w-0 gap-1.5 px-2 text-[12.5px] font-normal text-muted-foreground hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground data-popup-open:bg-muted data-popup-open:text-foreground"
          />
        }
      >
        <AgentIcon provider={settings.provider} className="size-3.5" />
        <span className="truncate text-foreground/85">{modelLabel}</span>
        {effort && <span className="shrink-0">{effort}</span>}
        <HugeiconsIcon icon={UnfoldMoreIcon} strokeWidth={1.8} className="size-3 opacity-60" />
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        // Above the button, or below it when there's more room there, and never taller than the
        // room: the list gives way first. Never beside it, where it would cover the message.
        collisionAvoidance={{ fallbackAxisSide: "none" }}
        className="max-h-(--available-height) w-[30rem] max-w-[calc(100vw-1.5rem)] gap-0 overflow-hidden rounded-xl p-0 shadow-lg"
      >
        <ModelPanel
          settings={settings}
          providers={providers}
          onChange={onChange}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  );
}

function ModelPanel({
  settings,
  providers,
  onChange,
  onDone,
}: {
  settings: ThreadSettings;
  providers: ProviderInfo[];
  onChange: (settings: ThreadSettings) => void;
  onDone: () => void;
}) {
  const { data: saved } = useLiveQuery({
    query: (q) => q.from({ row: settingsRows }).findOne(),
  });
  const last = saved?.lastByProvider ?? {};
  const [viewing, setViewing] = useState(settings.provider);
  const [search, setSearch] = useState("");
  const [highlight, setHighlight] = useState(keyOf(settings.provider, settings.model));

  const searching = search.trim() !== "";
  const viewed = providers.find((entry) => entry.id === viewing);
  // While searching, the models of every agent that can run; else those of the agent looked at.
  const shown = searching ? providers.filter(usable) : viewed && usable(viewed) ? [viewed] : [];
  const model = findModel(providers, settings.provider, settings.model);
  const efforts = model?.efforts ?? (settings.effort ? [settings.effort] : []);

  const view = (provider: ProviderInfo) => {
    setViewing(provider.id);
    setSearch("");
    // Start on the model in use, or the one used last with that agent.
    const wanted = provider.id === settings.provider ? settings.model : last[provider.id]?.model;
    const start = provider.models.find((entry) => entry.id === wanted) ?? provider.models[0];
    if (start) setHighlight(keyOf(provider.id, start.id));
  };
  const choose = (provider: ProviderId, chosen: string) => {
    onChange(withModel(settings, { provider, model: chosen }, providers, last));
    onDone();
  };
  const setEffort = (effort: string) => {
    if (effort !== settings.effort) onChange({ ...settings, effort });
  };
  // With nothing typed, left and right have no text to move through, so they set the thinking.
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (searching || efforts.length < 2) return;
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    setEffort(stepEffort(efforts, settings.effort, event.key === "ArrowRight" ? 1 : -1));
  };

  return (
    <Command
      filter={(_value, typed, keywords) => searchScore(keywords ?? [], typed)}
      value={highlight}
      onValueChange={setHighlight}
      loop
      className="min-h-0 rounded-none! bg-transparent p-0"
    >
      <div className="flex h-72 min-h-0">
        <div className="flex w-36 shrink-0 flex-col gap-0.5 border-r bg-muted/40 p-1.5">
          <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
            Agents
          </div>
          {providers.map((entry) => (
            <AgentButton
              key={entry.id}
              provider={entry}
              inUse={entry.id === settings.provider}
              // A search looks through every agent, so no one agent is the one looked at.
              viewed={!searching && entry.id === viewing}
              onClick={() => view(entry)}
            />
          ))}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3">
            <HugeiconsIcon
              icon={Search01Icon}
              strokeWidth={1.8}
              className="size-3.5 shrink-0 text-muted-foreground"
            />
            <CommandPrimitive.Input
              // oxlint-disable-next-line jsx-a11y/no-autofocus -- opened to pick from, by typing too.
              autoFocus
              value={search}
              onValueChange={setSearch}
              onKeyDown={onKeyDown}
              placeholder="Search all models…"
              spellCheck={false}
              className="h-full w-full min-w-0 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground"
            />
          </div>
          <CommandList className="max-h-none min-h-0 flex-1 scroll-py-1.5 p-1.5">
            {searching && (
              <CommandEmpty className="py-6 text-[12.5px] text-muted-foreground">
                No model has that name.
              </CommandEmpty>
            )}
            {!searching && !(viewed && usable(viewed)) && <AgentNotice provider={viewed} />}
            {shown.map((entry) => (
              <CommandGroup
                key={entry.id}
                heading={
                  searching ? (
                    <span className="flex items-center gap-1.5">
                      <AgentIcon provider={entry.id} className="size-3" />
                      {entry.label}
                    </span>
                  ) : undefined
                }
                className="p-0"
              >
                {entry.models.map((option) => (
                  <ModelRow
                    key={option.id}
                    provider={entry}
                    option={option}
                    current={entry.id === settings.provider && option.id === settings.model}
                    lastUsed={entry.id !== settings.provider && last[entry.id]?.model === option.id}
                    onSelect={() => choose(entry.id, option.id)}
                  />
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </div>
      </div>
      <Thinking
        modelLabel={model?.label ?? settings.model}
        efforts={efforts}
        effort={settings.effort}
        onChange={setEffort}
      />
      <PaletteFooter>
        <KeyHint keys={["ArrowUp", "ArrowDown"]}>Model</KeyHint>
        {efforts.length > 1 && <KeyHint keys={["ArrowLeft", "ArrowRight"]}>Thinking</KeyHint>}
        <KeyHint keys={["Enter"]}>Use</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </Command>
  );
}

/** What an agent's state is, in a word or two, for the list of agents. */
function agentState(provider: ProviderInfo, inUse: boolean): { text: string; trouble?: boolean } {
  if (provider.status === "missing") return { text: "Not installed", trouble: true };
  if (provider.status === "error") return { text: "Didn't start", trouble: true };
  if (provider.status === "checking" && provider.models.length === 0) return { text: "Checking…" };
  if (inUse) return { text: "In use" };
  const count = provider.models.length;
  return { text: `${count} ${count === 1 ? "model" : "models"}` };
}

function AgentButton({
  provider,
  inUse,
  viewed,
  onClick,
}: {
  provider: ProviderInfo;
  inUse: boolean;
  viewed: boolean;
  onClick: () => void;
}) {
  const state = agentState(provider, inUse);
  return (
    <button
      type="button"
      aria-pressed={viewed}
      onMouseDown={keepFocus}
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/50",
        viewed && "bg-background shadow-xs ring-1 ring-foreground/10 hover:bg-background",
      )}
    >
      <AgentIcon
        provider={provider.id}
        className={cn("size-4 shrink-0", state.trouble && "text-muted-foreground")}
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-[12.5px] text-foreground">{provider.label}</span>
        <span
          className={cn(
            "truncate text-[11px]",
            state.trouble ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground",
          )}
        >
          {state.text}
        </span>
      </span>
    </button>
  );
}

function ModelRow({
  provider,
  option,
  current,
  lastUsed,
  onSelect,
}: {
  provider: ProviderInfo;
  option: ModelOption;
  current: boolean;
  lastUsed: boolean;
  onSelect: () => void;
}) {
  const first = option.efforts[0];
  const top = option.efforts.at(-1);
  return (
    <CommandItem
      value={keyOf(provider.id, option.id)}
      keywords={[option.label, option.id, provider.label]}
      data-checked={current}
      onSelect={onSelect}
      className="items-start gap-3 py-2 [&>svg:last-child]:mt-0.5"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] text-foreground">{option.label}</span>
          {lastUsed && (
            <span className="shrink-0 rounded border px-1 text-[10.5px] leading-4 text-muted-foreground">
              Last used
            </span>
          )}
        </span>
        {option.description && (
          <span className="line-clamp-2 text-[11.5px] leading-snug text-muted-foreground">
            {option.description}
          </span>
        )}
      </span>
      {first && top && (
        <span
          title={`Thinks at ${option.efforts.map(effortLabel).join(", ")}`}
          className="mt-0.5 inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground"
        >
          <HugeiconsIcon icon={Brain02Icon} strokeWidth={1.8} className="size-3" />
          {first === top ? effortLabel(first) : `${effortLabel(first)}–${effortLabel(top)}`}
        </span>
      )}
    </CommandItem>
  );
}

/** Why an agent shows no models: it is being checked, isn't installed, or didn't start. */
function AgentNotice({ provider }: { provider: ProviderInfo | undefined }) {
  const [checking, setChecking] = useState(false);
  const checkAgain = () => {
    setChecking(true);
    server.call("providers.refresh", {}).then(
      () => setChecking(false),
      (error: unknown) => {
        setChecking(false);
        reportError("Could not check the agents again", error);
      },
    );
  };

  if (!provider || (provider.status === "checking" && provider.models.length === 0)) {
    return (
      <Notice>
        <Spinner className="size-4" />
        {provider ? `Checking ${provider.label}…` : "Looking for agents…"}
      </Notice>
    );
  }
  const title =
    provider.status === "missing"
      ? `${provider.label} isn't installed`
      : provider.status === "error"
        ? `${provider.label} didn't start`
        : `${provider.label} lists no models`;
  return (
    <Notice>
      <span className="font-medium text-foreground">{title}</span>
      {provider.message && <span>{provider.message}</span>}
      <Button
        variant="outline"
        size="sm"
        disabled={checking}
        onClick={checkAgain}
        className="mt-1.5 h-7 text-[12px]"
      >
        {checking && <Spinner className="size-3.5" />}
        Check again
      </Button>
    </Notice>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-[12.5px] text-muted-foreground">
      {children}
    </div>
  );
}

/** How hard the model in use thinks: a level for each one it takes, and what the level means. */
function Thinking({
  modelLabel,
  efforts,
  effort,
  onChange,
}: {
  modelLabel: string;
  efforts: string[];
  effort: string;
  onChange: (effort: string) => void;
}) {
  const hint = effortHint(effort);
  return (
    <div className="shrink-0 border-t px-3 pt-2.5 pb-3">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-[12px] font-medium text-foreground">Thinking</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted-foreground">
          for {modelLabel}
        </span>
      </div>
      {efforts.length > 0 ? (
        <>
          <fieldset
            aria-label="Thinking"
            className="mt-2 grid min-w-0 auto-cols-fr grid-flow-col gap-0.5 rounded-lg bg-muted p-0.5"
          >
            {efforts.map((level) => (
              <button
                key={level}
                type="button"
                aria-pressed={level === effort}
                onMouseDown={keepFocus}
                onClick={() => onChange(level)}
                className={cn(
                  "h-7 min-w-0 truncate rounded-md px-1.5 text-[12px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50",
                  level === effort &&
                    "bg-background font-medium text-foreground shadow-xs ring-1 ring-foreground/10",
                )}
              >
                {effortLabel(level)}
              </button>
            ))}
          </fieldset>
          {hint && <p className="mt-1.5 text-[11.5px] text-muted-foreground">{hint}</p>}
        </>
      ) : (
        <p className="mt-1 text-[11.5px] text-muted-foreground">
          This model takes no thinking level.
        </p>
      )}
    </div>
  );
}
