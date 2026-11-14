// Files as a folder tree, each marked with what the work did to it: the files a thread changed,
// or every file in a repository its work is in.

import { useEffect, useLayoutEffect, useRef } from "react";
import type { FileChange } from "@dodocode/protocol";
import type { GitStatus, GitStatusEntry } from "@pierre/trees";
import { FileTree, useFileTree } from "@pierre/trees/react";
import { cn } from "@dodocode/ui/lib/utils";

/** How the tree marks a file, for what the work did to it. */
export const TREE_STATUS: Record<FileChange["kind"], GitStatus> = {
  add: "added",
  update: "modified",
  delete: "deleted",
  move: "renamed",
};

/**
 * The tree draws itself apart from the page's styles, so it takes the theme's colours through
 * its own variables: the same text, borders and selection as the rest of the app.
 */
const TREE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-fg-override: var(--foreground);
    --trees-fg-muted-override: var(--muted-foreground);
    --trees-bg-muted-override: var(--muted);
    --trees-border-color-override: var(--border);
    --trees-selected-bg-override: var(--accent);
    --trees-selected-fg-override: var(--accent-foreground);
    --trees-focus-ring-color-override: var(--ring);
    --trees-accent-override: var(--primary);
    --trees-input-bg-override: var(--background);
    --trees-search-bg-override: var(--background);
    --trees-git-deleted-color-override: var(--destructive);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 12.5px;
  }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md, 6px); }
`;

/** The folders above each path, as the tree names a folder: with a slash at its end. */
export function foldersAbove(paths: Iterable<string>): string[] {
  const folders = new Set<string>();
  for (const path of paths) {
    let end = path.indexOf("/");
    while (end > 0) {
      folders.add(path.slice(0, end + 1));
      end = path.indexOf("/", end + 1);
    }
  }
  return [...folders];
}

export function PathTree({
  paths,
  status,
  open,
  expanded,
  search = false,
  label,
  onOpen,
  className,
}: {
  paths: readonly string[];
  status: readonly GitStatusEntry[];
  /** Every folder open at first, or only `expanded`. */
  open: boolean;
  /** The folders open at first when not every one is. */
  expanded?: readonly string[];
  /** With a search box over the tree. */
  search?: boolean;
  label: string;
  /** Called with a file as it's picked, by click or keyboard. */
  onOpen: (path: string) => void;
  className?: string;
}) {
  // The tree keeps the first handler it's given, so it calls the latest through this. The folders
  // to open are read as the paths come, and only then.
  const latest = useRef({ onOpen, expanded });
  useLayoutEffect(() => {
    latest.current = { onOpen, expanded };
  });
  const known = useRef<ReadonlySet<string>>(new Set());

  const { model } = useFileTree({
    paths: [],
    density: "compact",
    flattenEmptyDirectories: true,
    initialExpansion: open ? "open" : "closed",
    search,
    unsafeCSS: TREE_CSS,
    onSelectionChange: (selected) => {
      const path = selected.at(-1);
      if (path && known.current.has(path)) latest.current.onOpen(path);
    },
  });

  useEffect(() => {
    known.current = new Set(paths);
    const folders = latest.current.expanded;
    model.resetPaths(paths, folders ? { initialExpandedPaths: folders } : undefined);
  }, [model, paths]);

  useEffect(() => {
    model.setGitStatus(status);
  }, [model, status]);

  return (
    <FileTree
      model={model}
      aria-label={label}
      // Picking the file already picked changes nothing in the tree, so that click is caught here.
      onClickCapture={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
        const selected = model.getSelectedPaths();
        const path = selected.length === 1 ? selected[0] : undefined;
        if (!path || !known.current.has(path)) return;
        const onRow = event.nativeEvent
          .composedPath()
          .some((node) => node instanceof HTMLElement && node.dataset.itemPath === path);
        if (onRow) latest.current.onOpen(path);
      }}
      className={cn("block min-h-0 flex-1 overflow-hidden", className)}
    />
  );
}
