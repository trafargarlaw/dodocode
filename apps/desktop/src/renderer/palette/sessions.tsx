// The palette's pages for conversations agents had in other apps: find one, then bring it in as
// a thread that carries it on.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Command as CommandPrimitive } from "cmdk";
import type { OutsideSession, ProviderId, ThreadOrigin } from "@dodocode/protocol";
import { Alert02Icon, Folder01Icon, FolderAddIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@dodocode/ui/components/command";
import { RadioGroup, RadioGroupItem } from "@dodocode/ui/components/radio-group";
import { Spinner } from "@dodocode/ui/components/spinner";
import { toast } from "@dodocode/ui/components/toast";
import { cn } from "@dodocode/ui/lib/utils";
import { searchScore } from "../search-match";
import { providers, reportError } from "../server/app-data";
import { bringIn, errorText, useSessionPlace, useSessions } from "../server/sessions";
import { AgentIcon } from "../thread/model-picker";
import { ago, useNow } from "../time";
import { openThread } from "../view";
import {
  HEADER_INPUT,
  HeaderAction,
  KeyHint,
  ListHeading,
  PALETTE_COMMAND,
  PALETTE_LIST,
  PaletteFooter,
  PaletteHeader,
} from "./chrome";
import type { PaletteNav } from "./palette";

type Mode = ThreadOrigin["mode"];

/** Every conversation there is to bring in, newest first, to search. */
export function SessionsPage({ nav, search: typed }: { nav: PaletteNav; search?: string }) {
  const [search, setSearch] = useState(typed ?? "");
  const { listing, reading, error } = useSessions();
  const labels = useAgentLabels();
  const now = useNow();
  const sessions = listing?.sessions ?? [];

  return (
    <Command
      filter={(_value, query, keywords) => searchScore(keywords ?? [], query)}
      loop
      className={PALETTE_COMMAND}
    >
      <PaletteHeader
        onBack={nav.back}
        action={
          reading &&
          listing && (
            <Spinner className="mr-1 size-3.5 text-muted-foreground" aria-label="Looking again" />
          )
        }
      >
        <CommandPrimitive.Input
          data-palette-input
          // oxlint-disable-next-line jsx-a11y/no-autofocus -- the palette is opened to type in it.
          autoFocus
          value={search}
          onValueChange={setSearch}
          onKeyDown={(event) => {
            if (event.key !== "Backspace" || search) return;
            event.preventDefault();
            nav.back();
          }}
          placeholder="Search conversations from other apps"
          className={HEADER_INPUT}
        />
      </PaletteHeader>
      <CommandList className={PALETTE_LIST}>
        {listing ? (
          <CommandEmpty>No conversation matches.</CommandEmpty>
        ) : reading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-[13px] text-muted-foreground">
            <Spinner className="size-3.5" />
            Looking through the agents' history…
          </div>
        ) : (
          error && <Problem>{error}</Problem>
        )}
        {sessions.length > 0 && (
          <CommandGroup heading="Conversations">
            {sessions.map((session) => (
              <SessionItem
                key={`${session.provider}:${session.id}`}
                session={session}
                agent={labels(session.provider)}
                now={now}
                onSelect={() => {
                  if (!session.threadId) return nav.push({ kind: "bring", session });
                  nav.close();
                  openThread(session.threadId);
                }}
              />
            ))}
          </CommandGroup>
        )}
        {listing?.problems.map((problem) => (
          <Problem key={problem.provider}>
            Couldn't list {labels(problem.provider)}'s conversations: {problem.message}
          </Problem>
        ))}
      </CommandList>
      <PaletteFooter
        end={listing && <span className="tabular-nums">{countText(sessions.length)}</span>}
      >
        <KeyHint keys={["ArrowUp", "ArrowDown"]}>Navigate</KeyHint>
        <KeyHint keys={["Enter"]}>Select</KeyHint>
        <KeyHint keys={["Backspace"]}>Back</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </Command>
  );
}

/** A conversation in a list: its title, where it happened, and when it last did anything. */
export function SessionItem({
  session,
  agent,
  now,
  onSelect,
}: {
  session: OutsideSession;
  /** The agent's name, such as Claude. */
  agent: string;
  now: number;
  onSelect: () => void;
}) {
  const folder = folderName(session.cwd);
  return (
    <CommandItem
      value={`session:${session.provider}:${session.id}`}
      keywords={sessionWords(session, agent)}
      onSelect={onSelect}
      className="items-start gap-3 py-2"
    >
      <AgentIcon provider={session.provider} className="mt-0.5 size-4" />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13.5px] leading-tight text-foreground">
          {session.title}
        </span>
        <span className="truncate text-xs text-muted-foreground">
          {[session.app, folder, session.branch].filter(Boolean).join(" · ")}
        </span>
      </span>
      {session.threadId && (
        <span className="mt-px shrink-0 rounded-[5px] bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground">
          In dodocode
        </span>
      )}
      <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">
        {ago(session.updatedAt, now)}
      </span>
    </CommandItem>
  );
}

/** What a search matches a conversation by. */
export function sessionWords(session: OutsideSession, agent: string): string[] {
  return [
    session.title,
    session.app,
    folderName(session.cwd),
    session.branch ?? "",
    agent,
    session.cwd,
    // The whole of a long first message would only slow the search down.
    session.firstPrompt?.slice(0, 400) ?? "",
  ];
}

/** Each agent's name, by its id. */
export function useAgentLabels(): (provider: ProviderId) => string {
  const { data: list = [] } = useLiveQuery({ query: (q) => q.from({ provider: providers }) });
  return (provider) => list.find((each) => each.id === provider)?.label ?? provider;
}

/** How bringing a conversation in carries it on. */
const MODES: { value: Mode; title: string; explain: (app: string) => string }[] = [
  {
    value: "same",
    title: "Carry on the same conversation",
    explain: (app) =>
      `dodocode carries on the conversation itself. The agent remembers everything from before, and if you go back to it in ${app}, it remembers what was done here too, though what you say there won't show here. Work on it in one place at a time.`,
  },
  {
    value: "copy",
    title: "Carry on a copy",
    explain: (app) =>
      `dodocode carries on a copy. The agent remembers everything up to now, and the original stays in ${app} as it is. The two go their own ways from here.`,
  },
];

/** One conversation: where it goes, and whether it carries on itself or a copy. */
export function BringPage({ nav, session }: { nav: PaletteNav; session: OutsideSession }) {
  const { place, error } = useSessionPlace(session);
  const labels = useAgentLabels();
  const now = useNow();
  const [mode, setMode] = useState<Mode>("same");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const gone = place?.folderGone === true;
  const ready = place !== undefined && !busy;
  const page = useRef<HTMLDivElement>(null);
  // The bringing can outlast the palette. It still finishes, and says so in a toast instead.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // Focus starts on the choice, where the arrows change it; with none to make, on the action. A
  // frame late: until the radio group has counted its radios, it drops the first arrow pressed.
  // The page holds focus meanwhile, or the dialog would take it back.
  useEffect(() => {
    page.current?.focus();
    const frame = requestAnimationFrame(() => {
      const target = gone
        ? page.current
            ?.closest("[role=dialog]")
            ?.querySelector<HTMLElement>("[data-palette-action]")
        : page.current?.querySelector<HTMLElement>('[role="radio"][aria-checked="true"]');
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [gone]);

  const bring = () => {
    if (!ready) return;
    setBusy(true);
    setFailure(undefined);
    bringIn(session, gone ? "same" : mode).then(
      (thread) => {
        if (alive.current) {
          nav.close();
          openThread(thread.id);
        } else {
          toast.add({
            title: `Imported ${thread.title}`,
            description: "It's in your threads now.",
          });
        }
      },
      (failed: unknown) => {
        if (!alive.current) return reportError("Could not import the conversation", failed);
        setBusy(false);
        setFailure(errorText(failed));
        return undefined;
      },
    );
  };

  // On the choice, Enter brings it in and Backspace goes back, as in the palette's fields.
  const keys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      bring();
    } else if (event.key === "Backspace") {
      event.preventDefault();
      nav.back();
    }
  };

  return (
    <>
      <PaletteHeader
        onBack={nav.back}
        action={
          <HeaderAction hotkey="Enter" disabled={!ready} busy={busy} onClick={bring}>
            {busy ? "Importing…" : gone ? "Import its history" : "Import"}
          </HeaderAction>
        }
      >
        <span className="min-w-0 flex-1 truncate px-1 text-[14px] text-foreground">
          Import conversation
        </span>
      </PaletteHeader>
      <div
        ref={page}
        tabIndex={-1}
        className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto px-3.5 py-3.5 outline-none"
      >
        <div className="flex items-start gap-3 rounded-lg border bg-muted/30 px-3 py-2.5">
          <AgentIcon provider={session.provider} className="mt-0.5 size-4 shrink-0" />
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-[13.5px] leading-snug font-medium text-foreground">
              {session.title}
            </span>
            <span className="text-xs text-muted-foreground">
              {labels(session.provider)} in {session.app}
              {session.createdAt !== undefined && <> · started {agoText(session.createdAt, now)}</>}
              {" · "}last active {agoText(session.updatedAt, now)}
            </span>
            <span
              className="truncate font-mono text-[11.5px] text-muted-foreground"
              title={session.cwd}
            >
              {session.cwd}
              {session.branch && <span className="font-sans"> · {session.branch}</span>}
            </span>
          </div>
        </div>

        <PlaceRow place={place} error={error} />

        {gone ? (
          <Problem>
            The folder it worked in is gone, so it can't carry on. Its history still comes along, to
            read.
          </Problem>
        ) : (
          <div className="flex flex-col">
            <ListHeading className="px-0.5 pt-0">How it carries on</ListHeading>
            <RadioGroup
              value={mode}
              onValueChange={(value) => setMode(value as Mode)}
              onKeyDown={keys}
              disabled={busy}
              aria-label="How it carries on"
              className="gap-2"
            >
              {MODES.map((option) => (
                // oxlint-disable-next-line jsx-a11y/label-has-associated-control -- the radio inside is its control.
                <label
                  key={option.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 transition-colors",
                    mode === option.value ? "border-primary/60 bg-primary/5" : "hover:bg-muted/50",
                  )}
                >
                  <RadioGroupItem value={option.value} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="text-[13px] leading-tight font-medium text-foreground">
                      {option.title}
                    </span>
                    <span className="text-[12.5px] leading-relaxed text-muted-foreground">
                      {option.explain(session.app)}
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        )}
        {!gone && (
          <p className="px-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
            Either way, the whole conversation comes along: its messages, tool calls and subagents.
          </p>
        )}
        {failure && <Problem>{failure}</Problem>}
      </div>
      <PaletteFooter>
        {!gone && <KeyHint keys={["ArrowUp", "ArrowDown"]}>Choose</KeyHint>}
        <KeyHint keys={["Enter"]}>Import</KeyHint>
        <KeyHint keys={["Backspace"]}>Back</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </>
  );
}

/** Which project the thread goes in, or the project it adds. */
function PlaceRow({
  place,
  error,
}: {
  place: ReturnType<typeof useSessionPlace>["place"];
  error?: string;
}) {
  if (error) return <Problem>{error}</Problem>;
  const project = place?.project;
  return (
    <div className="flex h-11 items-center gap-3 rounded-lg border bg-muted/30 px-3">
      <span className="shrink-0 text-[12px] text-muted-foreground">Goes in</span>
      {!place ? (
        <Spinner className="size-3.5 text-muted-foreground" />
      ) : project ? (
        <>
          <HugeiconsIcon
            icon={project.id ? Folder01Icon : FolderAddIcon}
            strokeWidth={1.8}
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate text-[13px] text-foreground" title={project.path}>
            {project.id ? project.name : `${project.name}, added as a project`}
          </span>
        </>
      ) : (
        <span className="text-[13px] text-muted-foreground">No project</span>
      )}
    </div>
  );
}

function Problem({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex items-start gap-2 px-2 py-2 text-[12.5px] leading-snug text-destructive"
    >
      <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0">{children}</span>
    </div>
  );
}

function countText(count: number): string {
  return count === 1 ? "1 conversation" : `${count} conversations`;
}

/** "3h ago", or "just now". */
function agoText(at: number, now: number): string {
  const short = ago(at, now);
  return short === "now" ? "just now" : `${short} ago`;
}

/** The last part of a folder's path. */
export function folderName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
