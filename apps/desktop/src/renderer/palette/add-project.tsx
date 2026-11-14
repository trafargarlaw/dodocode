// The palette's pages for adding a project: the ways to add one, the folder browser, and the
// pages that start a new repository or clone one.

import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type KeyboardEvent,
  type ReactNode,
  type SetStateAction,
} from "react";
import { useLiveQuery } from "@tanstack/react-db";
import { Command as CommandPrimitive } from "cmdk";
import {
  folderNameProblem,
  githubUrl,
  repoName,
  type FolderListing,
  type Project,
} from "@dodocode/protocol";
import {
  Alert02Icon,
  BubbleChatDownload01Icon,
  Folder01Icon,
  FolderAddIcon,
  FolderGit2Icon,
  FolderOpenIcon,
  GithubIcon,
  Link01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Button } from "@dodocode/ui/components/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@dodocode/ui/components/command";
import { Spinner } from "@dodocode/ui/components/spinner";
import { toast } from "@dodocode/ui/components/toast";
import { cn } from "@dodocode/ui/lib/utils";
import { searchScore } from "../search-match";
import { projects, reportError } from "../server/app-data";
import { server } from "../server/connection";
import {
  HEADER_INPUT,
  HeaderAction,
  HeaderInput,
  KeyHint,
  ListHeading,
  PALETTE_COMMAND,
  PALETTE_LIST,
  PaletteFooter,
  PaletteHeader,
} from "./chrome";
import {
  childPath,
  folderName,
  matchFolders,
  parentOf,
  samePath,
  showPath,
  splitTyped,
  upFrom,
} from "./folder-path";
import type { PaletteNav, PalettePage } from "./palette";

export interface Source {
  id: string;
  title: string;
  description: string;
  icon: typeof FolderAddIcon;
  page: PalettePage;
  /** Other words a search finds it by. */
  keywords: string[];
}

/** The ways to add a project. */
export const SOURCES: Source[] = [
  {
    id: "new",
    title: "New project",
    description: "Start a new Git repository from a name",
    icon: FolderAddIcon,
    page: { kind: "create" },
    keywords: ["create", "init", "empty", "repository"],
  },
  {
    id: "folder",
    title: "Local folder",
    description: "Pick a folder on this computer",
    icon: FolderOpenIcon,
    page: { kind: "folder", purpose: "add" },
    keywords: ["open", "browse", "disk", "directory", "existing"],
  },
  {
    id: "url",
    title: "Git URL",
    description: "Clone a repository from its address",
    icon: Link01Icon,
    page: { kind: "clone", via: "url" },
    keywords: ["clone", "remote", "https", "ssh", "gitlab", "bitbucket"],
  },
  {
    id: "github",
    title: "GitHub repository",
    description: "Clone owner/repo from GitHub",
    icon: GithubIcon,
    page: { kind: "clone", via: "github" },
    keywords: ["clone", "github", "gh"],
  },
];

export function SourcesPage({ nav }: { nav: PaletteNav }) {
  const [search, setSearch] = useState("");
  // Learns the home folder now, so the folder pages can write paths with `~` from the start.
  useHome();
  return (
    <Command
      filter={(_value, query, keywords) => searchScore(keywords ?? [], query)}
      loop
      className={PALETTE_COMMAND}
    >
      <PaletteHeader onBack={nav.back}>
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
          placeholder="Add a project from…"
          className={HEADER_INPUT}
        />
      </PaletteHeader>
      <CommandList className={PALETTE_LIST}>
        <CommandEmpty>Nothing matches.</CommandEmpty>
        <CommandGroup heading="Sources">
          {SOURCES.map((source) => (
            <CommandItem
              key={source.id}
              value={`source:${source.id}`}
              keywords={[source.title, source.description, ...source.keywords]}
              onSelect={() => nav.push(source.page)}
              className="items-start gap-3 py-2"
            >
              <HugeiconsIcon icon={source.icon} strokeWidth={1.8} className="mt-0.5 size-4" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[13.5px] leading-tight text-foreground">{source.title}</span>
                <span className="text-xs text-muted-foreground">{source.description}</span>
              </span>
            </CommandItem>
          ))}
          {/* A conversation from another app comes with its project, adding it when it's new. Not
              among the sources a search lists, which has this as an action of its own. */}
          <CommandItem
            value="source:import"
            keywords={[
              "Import conversation",
              IMPORT_DESCRIPTION,
              "bring in",
              "session",
              "chat",
              "history",
              "resume",
              "continue",
              "Claude Code",
              "Codex",
              "T3 Code",
            ]}
            onSelect={() => nav.push({ kind: "sessions" })}
            className="items-start gap-3 py-2"
          >
            <HugeiconsIcon
              icon={BubbleChatDownload01Icon}
              strokeWidth={1.8}
              className="mt-0.5 size-4"
            />
            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-[13.5px] leading-tight text-foreground">
                Import conversation
              </span>
              <span className="text-xs text-muted-foreground">{IMPORT_DESCRIPTION}</span>
            </span>
          </CommandItem>
        </CommandGroup>
      </CommandList>
      <PaletteFooter>
        <KeyHint keys={["ArrowUp", "ArrowDown"]}>Navigate</KeyHint>
        <KeyHint keys={["Enter"]}>Select</KeyHint>
        <KeyHint keys={["Backspace"]}>Back</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </Command>
  );
}

const IMPORT_DESCRIPTION = "Carry on a conversation from Claude Code, Codex or another app";

// Folders

/** What was read of each folder, by the folder as typed, so one seen before shows at once. */
const listings = new Map<string, FolderListing>();
/** The home folder, once a listing has said it. */
let knownHome: string | undefined;

/**
 * The folders in a folder. While it is read, the last listing stays, marked stale: the one read
 * before of the same folder, or of the folder shown before.
 */
function useFolderListing(folder: string): {
  listing?: FolderListing;
  error?: string;
  stale: boolean;
} {
  const [result, setResult] = useState<{ folder: string; listing?: FolderListing; error?: string }>(
    () => ({ folder: "", listing: listings.get(folder) }),
  );
  useEffect(() => {
    let live = true;
    server.call("folder.list", { path: folder }).then(
      (listing) => {
        listings.set(folder, listing);
        knownHome = listing.home;
        if (live) setResult({ folder, listing });
      },
      (error: unknown) => {
        if (live) setResult({ folder, error: errorText(error) });
      },
    );
    return () => {
      live = false;
    };
  }, [folder]);
  if (result.folder === folder) return { ...result, stale: false };
  return { listing: listings.get(folder) ?? result.listing, stale: true };
}

/** The home folder, asked for once if no listing has said it yet. */
function useHome(): string | undefined {
  const [home, setHome] = useState(knownHome);
  useEffect(() => {
    if (home) return;
    let live = true;
    server.call("folder.list", { path: "~/" }).then(
      (listing) => {
        listings.set("~/", listing);
        knownHome = listing.home;
        if (live) setHome(listing.home);
      },
      // The paths are then written in full, which works as well.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [home]);
  return home;
}

/** Where browsing starts and new projects go: beside the project added last, or else home. */
function startFolder(home: string | undefined): string {
  const latest = projects.toArray.toSorted((a, b) => b.createdAt - a.createdAt)[0];
  const parent = latest && parentOf(latest.path);
  if (!parent) return "~/";
  return home ? showPath(parent, home) : showPath(parent, "");
}

const FILE_MANAGER =
  window.dodocode.platform === "darwin"
    ? "Finder"
    : window.dodocode.platform === "win32"
      ? "File Explorer"
      : "Files";

/**
 * Browses the folders by typing a path, as in a terminal: the list narrows to what is typed,
 * and opening a folder types its name. Adds the folder as a project, or picks where a new one
 * goes.
 */
export function FolderPage({
  nav,
  purpose,
  location,
  onLocation,
}: {
  nav: PaletteNav;
  purpose: "add" | "location";
  /** Where a new project goes now, which picking a location starts from. */
  location?: string;
  onLocation: (location: string) => void;
}) {
  const home = useHome();
  const [typed, setTyped] = useState(
    () => (purpose === "location" && location) || startFolder(home),
  );
  const { folder, filter } = splitTyped(typed);
  const { listing, error, stale } = useFolderListing(folder);
  const { data: projectList = [] } = useLiveQuery({
    query: (q) => q.from({ project: projects }),
  });
  const matches = listing ? matchFolders(listing.folders, filter) : [];
  // The row picked with the arrows, for what is typed now. Typing more starts over: on the first
  // match when a name is being typed, else on no row, so Enter takes the folder typed.
  const [picked, setPicked] = useState<{ typed: string; index: number }>();
  const highlight = Math.min(
    picked?.typed === typed ? picked.index : filter && matches.length > 0 ? 0 : -1,
    matches.length - 1,
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const listId = useId();

  const row = highlight >= 0 ? matches[highlight] : undefined;
  const exact = matches.find((entry) => entry.name.toLowerCase() === filter.toLowerCase());
  // What the header's button takes: the row picked, the folder whose name is typed in full, or
  // the folder listed when no name is typed.
  const target =
    !listing || stale
      ? undefined
      : row
        ? { path: childPath(listing.path, row.name), name: row.name }
        : exact
          ? { path: childPath(listing.path, exact.name), name: exact.name }
          : !filter
            ? { path: listing.path, name: folderName(showPath(listing.path, listing.home)) }
            : undefined;
  const verb = purpose === "add" ? "Add" : "Use";

  const type = (text: string) => {
    setTyped(text);
    setFailure(undefined);
  };
  const open = (name: string) => type(`${folder}${name}/`);
  const choose = (path: string) => {
    if (busy) return;
    if (purpose === "location") {
      onLocation(showPath(path, listing?.home ?? home ?? ""));
      return;
    }
    setBusy(true);
    setFailure(undefined);
    server.call("project.add", { path }).then(nav.added, (failed: unknown) => {
      setBusy(false);
      setFailure(errorText(failed));
    });
  };
  const browse = () => {
    void window.dodocode
      .pickFolder(listing && !stale ? listing.path : undefined)
      .then((path) => path && choose(path));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setPicked({ typed, index: Math.min(highlight + 1, matches.length - 1) });
        break;
      case "ArrowUp":
        event.preventDefault();
        setPicked({ typed, index: Math.max(highlight - 1, -1) });
        break;
      case "Tab": {
        // Completes the name, as a terminal does.
        const next = matches[Math.max(highlight, 0)];
        if (!next || event.shiftKey) break;
        event.preventDefault();
        open(next.name);
        break;
      }
      case "Enter":
        if (event.nativeEvent.isComposing) break;
        event.preventDefault();
        if (row && !(event.ctrlKey || event.metaKey)) open(row.name);
        else if (target) choose(target.path);
        break;
      case "Backspace": {
        if (!typed) {
          event.preventDefault();
          nav.back();
          break;
        }
        // At the end of a folder's path, goes up a folder rather than taking off the slash.
        const input = event.currentTarget;
        const atEnd = input.selectionStart === typed.length && input.selectionEnd === typed.length;
        if (!typed.endsWith("/") || !atEnd || stale) break;
        event.preventDefault();
        const up =
          upFrom(typed) ?? (listing?.parent ? showPath(listing.parent, listing.home) : undefined);
        if (up) type(up);
        else nav.back();
        break;
      }
    }
  };

  return (
    <>
      <PaletteHeader
        onBack={nav.back}
        action={
          <HeaderAction
            hotkey={row ? "Mod+Enter" : "Enter"}
            disabled={!target}
            busy={busy}
            onClick={() => target && choose(target.path)}
            title={target?.path}
          >
            {busy ? "Adding…" : target ? `${verb} ${target.name}` : verb}
          </HeaderAction>
        }
      >
        <HeaderInput
          value={typed}
          onChange={(event) => type(event.target.value)}
          onKeyDown={onKeyDown}
          readOnly={busy}
          placeholder="~/"
          // It is an input, which the rule can't see through HeaderInput.
          // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={row ? `${listId}-${highlight}` : undefined}
          aria-label={purpose === "add" ? "Folder to add" : "Folder the new project goes in"}
        />
      </PaletteHeader>
      {failure && (
        <div className="border-b px-4 py-2">
          <Notice tone="error">{failure}</Notice>
        </div>
      )}
      <div
        id={listId}
        // A select can't hold these rows. The field keeps the focus, as in any combobox.
        // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
        role="listbox"
        aria-label="Folders"
        className={cn(
          "h-[min(48vh,21rem)] overflow-y-auto p-1.5 transition-opacity",
          stale && "opacity-60",
        )}
      >
        <ListHeading>
          {purpose === "add" ? "Folders" : "Pick the folder the new project goes in"}
        </ListHeading>
        {matches.map((entry, index) => {
          const path = listing ? childPath(listing.path, entry.name) : entry.name;
          const added = projectList.some((project) => samePath(project.path, path));
          const lit = index === highlight;
          return (
            // The keys work from the field, which keeps the focus; a click opens the folder.
            // oxlint-disable-next-line jsx-a11y/click-events-have-key-events
            <div
              key={entry.name}
              id={`${listId}-${index}`}
              // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
              role="option"
              tabIndex={-1}
              aria-selected={lit}
              data-highlighted={lit || undefined}
              // The row the arrows reach scrolls into view.
              ref={lit ? (element) => element?.scrollIntoView({ block: "nearest" }) : undefined}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => open(entry.name)}
              className="group/row flex h-8 cursor-default items-center gap-2.5 rounded-lg px-2 text-[13px] text-foreground hover:bg-muted/60 data-highlighted:bg-muted"
            >
              <HugeiconsIcon
                icon={entry.git ? FolderGit2Icon : Folder01Icon}
                strokeWidth={1.8}
                className="size-4 shrink-0 text-muted-foreground"
              />
              <span className="min-w-0 truncate">{entry.name}</span>
              {entry.git && <Tag>Git</Tag>}
              {added && <Tag>Added</Tag>}
              <button
                type="button"
                tabIndex={-1}
                disabled={busy}
                onMouseDown={(event) => event.preventDefault()}
                onClick={(event) => {
                  event.stopPropagation();
                  choose(path);
                }}
                className="ml-auto shrink-0 rounded-md border bg-background px-2 py-0.5 text-xs font-medium opacity-0 transition-opacity group-hover/row:opacity-100 group-data-highlighted/row:opacity-100 hover:bg-muted"
              >
                {verb}
              </button>
            </div>
          );
        })}
        <div className="px-2 py-3">
          {error ? (
            <Notice tone="error">{error}</Notice>
          ) : !listing ? (
            <Notice>
              <Spinner className="size-3.5" /> Reading the folder…
            </Notice>
          ) : matches.length === 0 && !stale ? (
            <Notice>
              {filter
                ? `No folder here has “${filter}” in its name.`
                : "There are no folders in here."}
            </Notice>
          ) : null}
        </div>
      </div>
      <PaletteFooter
        end={
          <button
            type="button"
            onClick={browse}
            className="rounded-md px-1.5 py-0.5 transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            Browse in {FILE_MANAGER}
          </button>
        }
      >
        <KeyHint keys={["ArrowUp", "ArrowDown"]}>Navigate</KeyHint>
        <KeyHint keys={["Enter"]}>{row ? "Open" : verb}</KeyHint>
        <KeyHint keys={["Backspace"]}>Up</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </>
  );
}

// New and cloned projects

/** What was typed into the pages that make a project, kept while a page on top picks a folder. */
export interface Forms {
  /** The new project's name. */
  name: string;
  /** The repository to clone, as typed. */
  url: string;
  /** The folder to clone into, when the repository's own name won't do. */
  folderName: string;
  /** Where the new project goes, as the browser shows it; unset for the usual place. */
  location?: string;
}

interface FormPageProps {
  nav: PaletteNav;
  forms: Forms;
  setForms: Dispatch<SetStateAction<Forms>>;
}

export function CreatePage({ nav, forms, setForms }: FormPageProps) {
  const home = useHome();
  const location = forms.location ?? startFolder(home);
  const { listing, stale } = useFolderListing(location);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const name = forms.name.trim();
  const problem = name
    ? (folderNameProblem(name) ?? clash(stale ? undefined : listing, name, location))
    : undefined;
  const ready = Boolean(name) && !problem && !busy;

  const create = () => {
    if (!ready) return;
    setBusy(true);
    setFailure(undefined);
    server.call("project.create", { parent: location, name }).then(nav.added, (error: unknown) => {
      setBusy(false);
      setFailure(errorText(error));
    });
  };

  return (
    <>
      <PaletteHeader
        onBack={nav.back}
        action={
          <HeaderAction hotkey="Enter" disabled={!ready} busy={busy} onClick={create}>
            {busy ? "Creating…" : "Create"}
          </HeaderAction>
        }
      >
        <HeaderInput
          value={forms.name}
          onChange={(event) => {
            setForms((current) => ({ ...current, name: event.target.value }));
            setFailure(undefined);
          }}
          onKeyDown={(event) => formKeys(event, forms.name, create, nav.back)}
          readOnly={busy}
          placeholder="Name the new project"
          aria-label="Project name"
        />
      </PaletteHeader>
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
        <LocationRow
          location={location}
          disabled={busy}
          onChange={() => nav.push({ kind: "folder", purpose: "location" })}
        />
        <p className="px-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          Makes the folder <NewPath location={location} name={name} /> with a new Git repository and
          an empty first commit, so tasks can work in worktrees of their own.
        </p>
        {(problem ?? failure) && <Notice tone="error">{problem ?? failure}</Notice>}
      </div>
      <PaletteFooter>
        <KeyHint keys={["Enter"]}>Create</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </>
  );
}

export function ClonePage({
  nav,
  via,
  forms,
  setForms,
}: FormPageProps & { via: "url" | "github" }) {
  const home = useHome();
  const location = forms.location ?? startFolder(home);
  const { listing, stale } = useFolderListing(location);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  // A clone can outlast the palette. It still finishes, and says so in a toast instead.
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const typed = forms.url.trim();
  const url = via === "github" ? githubUrl(typed) : typed || undefined;
  const derived = url ? repoName(url) : undefined;
  const name = forms.folderName.trim() || derived || "";
  const problem = !typed
    ? undefined
    : !url
      ? "Write it as owner/repo, or paste the repository's GitHub address."
      : !name
        ? "Name the folder to clone into."
        : (folderNameProblem(name) ?? clash(stale ? undefined : listing, name, location));
  const ready = Boolean(url && name) && !problem && !busy;

  const clone = () => {
    if (!ready || !url) return;
    setBusy(true);
    setFailure(undefined);
    server.call("project.clone", { url, parent: location, name }).then(
      (project: Project) => {
        if (alive.current) nav.added(project);
        else
          toast.add({ title: `Cloned ${project.name}`, description: "It's in your projects now." });
      },
      (error: unknown) => {
        if (!alive.current) return reportError("Could not clone the repository", error);
        setBusy(false);
        setFailure(errorText(error));
        return undefined;
      },
    );
  };

  return (
    <>
      <PaletteHeader
        onBack={nav.back}
        action={
          <HeaderAction hotkey="Enter" disabled={!ready} busy={busy} onClick={clone}>
            {busy ? "Cloning…" : "Clone"}
          </HeaderAction>
        }
      >
        <HeaderInput
          value={forms.url}
          onChange={(event) => {
            setForms((current) => ({ ...current, url: event.target.value }));
            setFailure(undefined);
          }}
          onKeyDown={(event) => formKeys(event, forms.url, clone, nav.back)}
          readOnly={busy}
          placeholder={via === "github" ? "owner/repo" : "https://… or git@host:owner/repo.git"}
          aria-label={via === "github" ? "GitHub repository" : "Repository address"}
        />
      </PaletteHeader>
      <div className="flex flex-col gap-3 px-3.5 py-3.5">
        <LocationRow
          location={location}
          disabled={busy}
          onChange={() => nav.push({ kind: "folder", purpose: "location" })}
        />
        <label className="flex h-11 items-center gap-3 rounded-lg border pr-3 pl-3">
          <span className="shrink-0 text-[12px] text-muted-foreground">Folder name</span>
          <input
            value={forms.folderName}
            onChange={(event) => {
              setForms((current) => ({ ...current, folderName: event.target.value }));
              setFailure(undefined);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
              event.preventDefault();
              clone();
            }}
            readOnly={busy}
            spellCheck={false}
            autoComplete="off"
            placeholder={derived ?? "Taken from the address"}
            className="h-full min-w-0 flex-1 bg-transparent font-mono text-[12.5px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
        </label>
        <p className="px-0.5 text-[12.5px] leading-relaxed text-muted-foreground">
          {url ? (
            <>
              Clones <span className="font-mono text-foreground">{url}</span>
            </>
          ) : (
            "Clones the repository"
          )}{" "}
          into <NewPath location={location} name={name} />. A private repository uses the Git
          sign-in on this computer.
        </p>
        {busy && (
          <Notice>
            <Spinner className="size-3.5" />
            Cloning. A big repository can take a minute; closing this won't stop it.
          </Notice>
        )}
        {(problem ?? failure) && <Notice tone="error">{problem ?? failure}</Notice>}
      </div>
      <PaletteFooter>
        <KeyHint keys={["Enter"]}>Clone</KeyHint>
        <KeyHint keys={["Tab"]}>Next field</KeyHint>
        <KeyHint keys={["Escape"]}>Close</KeyHint>
      </PaletteFooter>
    </>
  );
}

/** Enter runs the page's action, and Backspace in an empty field goes back. */
function formKeys(
  event: KeyboardEvent<HTMLInputElement>,
  value: string,
  run: () => void,
  back: () => void,
): void {
  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
    event.preventDefault();
    run();
  } else if (event.key === "Backspace" && !value) {
    event.preventDefault();
    back();
  }
}

/** Why a new folder can't go in the listed one: one there has the name already. */
function clash(listing: FolderListing | undefined, name: string, location: string) {
  const taken = listing?.folders.find((entry) => entry.name.toLowerCase() === name.toLowerCase());
  return taken ? `There's already a folder named ${taken.name} in ${location}` : undefined;
}

function LocationRow({
  location,
  disabled,
  onChange,
}: {
  location: string;
  disabled: boolean;
  onChange: () => void;
}) {
  return (
    <div className="flex h-11 items-center gap-3 rounded-lg border bg-muted/30 pr-1.5 pl-3">
      <span className="shrink-0 text-[12px] text-muted-foreground">Goes in</span>
      <span
        className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-foreground"
        title={location}
      >
        {location}
      </span>
      <Button variant="outline" size="sm" onClick={onChange} disabled={disabled}>
        <HugeiconsIcon icon={FolderOpenIcon} strokeWidth={1.8} />
        Change…
      </Button>
    </div>
  );
}

/** The folder a new project will be, with a stand-in while it has no name. */
function NewPath({ location, name }: { location: string; name: string }) {
  return (
    <span className="font-mono text-foreground">
      {location}
      {name || <span className="text-muted-foreground italic">name</span>}/
    </span>
  );
}

function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 rounded-[5px] bg-muted px-1.5 py-px text-[10.5px] font-medium text-muted-foreground group-data-highlighted/row:bg-background">
      {children}
    </span>
  );
}

function Notice({ tone, children }: { tone?: "error"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 text-[12.5px] leading-snug",
        tone === "error" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {tone === "error" && (
        <HugeiconsIcon icon={Alert02Icon} strokeWidth={1.8} className="mt-px size-3.5 shrink-0" />
      )}
      <span className="flex min-w-0 items-center gap-2">{children}</span>
    </div>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
