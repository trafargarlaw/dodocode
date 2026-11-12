// The slash commands the agent takes, offered while the person types one at the start of a
// message: `/compact`, `/autocompact 150000`, a project's own.

import { useEffect, useSyncExternalStore } from "react";
import type { ProviderId, SlashCommand } from "@dodocode/protocol";
import { server } from "../server/connection";

/**
 * The commands the draft could be starting, those whose name starts with what was typed first.
 * Unset when the draft starts none: it is not a slash and a name, with nothing after it.
 */
export function commandMatches(
  commands: readonly SlashCommand[],
  text: string,
): SlashCommand[] | undefined {
  const typed = /^\/(\S*)$/.exec(text)?.[1]?.toLowerCase();
  if (typed === undefined) return undefined;
  const starts: SlashCommand[] = [];
  const contains: SlashCommand[] = [];
  for (const command of commands) {
    const name = command.name.toLowerCase();
    if (name.startsWith(typed)) starts.push(command);
    else if (name.includes(typed)) contains.push(command);
  }
  return [...starts.toSorted(byName), ...contains.toSorted(byName)];
}

function byName(a: SlashCommand, b: SlashCommand): number {
  return a.name.localeCompare(b.name);
}

// The lists, kept while the app runs. A project's own commands are known once an agent ran
// there, so each list loads again whenever the menu opens.

const lists = new Map<string, SlashCommand[]>();
const listeners = new Set<() => void>();
const NONE: SlashCommand[] = [];

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The commands the provider takes in the project. They load again each time `open` turns on. */
export function useSlashCommands(
  provider: ProviderId,
  projectId: string | undefined,
  open: boolean,
): SlashCommand[] {
  const key = `${provider}:${projectId ?? ""}`;
  const commands = useSyncExternalStore(subscribe, () => lists.get(key) ?? NONE);
  useEffect(() => {
    if (!open) return;
    server.call("commands.list", { provider, projectId }).then(
      (list) => {
        lists.set(key, list);
        for (const listener of Array.from(listeners)) listener();
      },
      // Without them the menu stays shut, and the command still goes as it was typed.
      () => {},
    );
  }, [open, key, provider, projectId]);
  return commands;
}
