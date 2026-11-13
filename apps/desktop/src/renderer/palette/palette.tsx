// The command palette: one dialog whose pages stack, so a page can lead to another and Back
// returns. It searches, adds projects (from a folder, a new repository or a clone), and brings in
// conversations agents had in other apps.

import { useRef, useState, useSyncExternalStore, type RefObject } from "react";
import type { OutsideSession, Project } from "@dodocode/protocol";
import { Dialog, DialogContent, DialogTitle } from "@dodocode/ui/components/dialog";
import { CreatePage, ClonePage, FolderPage, SourcesPage, type Forms } from "./add-project";
import { SearchPage } from "./search";
import { BringPage, SessionsPage } from "./sessions";

export type PalettePage =
  | { kind: "search" }
  /** The ways to add a project. */
  | { kind: "sources" }
  /** Browses the folders, to add one as a project, or to pick where a new one goes. */
  | { kind: "folder"; purpose: "add" | "location" }
  | { kind: "create" }
  | { kind: "clone"; via: "url" | "github" }
  /** The conversations agents had in other apps, to bring one in. */
  | { kind: "sessions"; search?: string }
  /** How one of them comes in. */
  | { kind: "bring"; session: OutsideSession };

interface PaletteState {
  open: boolean;
  stack: PalettePage[];
  /** Runs with the project the palette added, instead of opening a new thread in it. */
  onAdded?: (project: Project) => void;
}

let state: PaletteState = { open: false, stack: [{ kind: "search" }] };
const listeners = new Set<() => void>();

function set(next: PaletteState): void {
  state = next;
  for (const listener of Array.from(listeners)) listener();
}

/**
 * Opens the palette on search, or on the ways to add a project. `onAdded` gets the project it
 * adds; without it, a new thread opens in that project.
 */
export function openPalette(
  start: "search" | "add-project",
  options: { onAdded?: (project: Project) => void } = {},
): void {
  set({
    open: true,
    stack: [start === "search" ? { kind: "search" } : { kind: "sources" }],
    onAdded: options.onAdded,
  });
}

export function closePalette(): void {
  if (state.open) set({ ...state, open: false });
}

function usePalette(): PaletteState {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => state,
  );
}

/** What a page can do to the palette around it. */
export interface PaletteNav {
  push: (page: PalettePage) => void;
  /** Returns to the page before, or closes the palette from the first one. */
  back: () => void;
  close: () => void;
  /** Hands over a project the palette added, and closes it. */
  added: (project: Project) => void;
}

export function Palette({
  onNewThread,
  composer,
}: {
  onNewThread: (projectId?: string) => void;
  /** The message box on screen, where focus goes once the palette closes. */
  composer: RefObject<HTMLElement | null>;
}) {
  const { open } = usePalette();
  const popup = useRef<HTMLDivElement>(null);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closePalette())}>
      <DialogContent
        ref={popup}
        showCloseButton={false}
        // The page's own field, not its back button, which comes first.
        initialFocus={() => popup.current?.querySelector<HTMLElement>("[data-palette-input]")}
        // Back to typing, unless what was picked took focus already, as a new thread asking for
        // its project does.
        finalFocus={() => {
          const active = document.activeElement;
          const taken = active && active !== document.body && !popup.current?.contains(active);
          return taken ? false : (composer.current ?? true);
        }}
        className="top-[14%] flex max-h-[min(72vh,34rem)] translate-y-0 flex-col gap-0 overflow-hidden rounded-2xl p-0 shadow-2xl sm:max-w-xl"
      >
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        {/* Mounted only while open, so its queries run only then and each opening starts fresh. */}
        {open && <PaletteBody onNewThread={onNewThread} />}
      </DialogContent>
    </Dialog>
  );
}

function PaletteBody({ onNewThread }: { onNewThread: (projectId?: string) => void }) {
  const { stack, onAdded } = usePalette();
  // What was typed into the pages that make a project, kept while a page on top picks a folder.
  const [forms, setForms] = useState<Forms>({ name: "", url: "", folderName: "" });
  const page = stack.at(-1) ?? { kind: "search" };

  const nav: PaletteNav = {
    push: (next) => set({ ...state, stack: [...state.stack, next] }),
    back: () =>
      state.stack.length > 1
        ? set({ ...state, stack: state.stack.slice(0, -1) })
        : set({ ...state, open: false }),
    close: closePalette,
    added: (project) => {
      closePalette();
      if (onAdded) onAdded(project);
      else onNewThread(project.id);
    },
  };

  // Keyed by depth, so a page starts fresh each time it is opened, and its field takes focus.
  const key = stack.length;
  switch (page.kind) {
    case "search":
      return <SearchPage key={key} nav={nav} onNewThread={onNewThread} />;
    case "sources":
      return <SourcesPage key={key} nav={nav} />;
    case "folder":
      return (
        <FolderPage
          key={key}
          nav={nav}
          purpose={page.purpose}
          location={forms.location}
          onLocation={(location) => {
            setForms((current) => ({ ...current, location }));
            nav.back();
          }}
        />
      );
    case "create":
      return <CreatePage key={key} nav={nav} forms={forms} setForms={setForms} />;
    case "clone":
      return <ClonePage key={key} nav={nav} via={page.via} forms={forms} setForms={setForms} />;
    case "sessions":
      return <SessionsPage key={key} nav={nav} search={page.search} />;
    case "bring":
      return <BringPage key={key} nav={nav} session={page.session} />;
  }
}
