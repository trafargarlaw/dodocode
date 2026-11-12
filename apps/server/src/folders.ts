// The folders on the server's machine, for picking a project's folder in the window.

import { access, opendir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { FolderEntry, FolderListing } from "@dodocode/protocol";

/** A path as the person typed it, with `~` for the home folder, made absolute. */
export function expandPath(path: string, home = homedir()): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "~") return home;
  if (/^~[/\\]/.test(trimmed)) return resolve(home, trimmed.slice(2));
  // A drive letter alone means the top of that drive, not the folder last used on it.
  if (/^[a-z]:$/i.test(trimmed)) return resolve(`${trimmed}\\`);
  return resolve(home, trimmed);
}

/** The folders in a folder, by name, each marked when it is a git repository. */
export async function listFolders(path: string, home = homedir()): Promise<FolderListing> {
  const full = expandPath(path, home);
  let entries;
  try {
    entries = await readdir(full, { withFileTypes: true });
  } catch (error) {
    throw new Error(problem(full, error), { cause: error });
  }
  const found = await Promise.all(
    entries.map(async (entry): Promise<FolderEntry | undefined> => {
      const folder = join(full, entry.name);
      if (entry.isSymbolicLink()) {
        // Followed only when it leads to a folder that opens. Windows keeps links in the home
        // folder, such as "Application Data", that nobody may list.
        try {
          if (!(await stat(folder)).isDirectory()) return undefined;
          await (await opendir(folder)).close();
        } catch {
          return undefined;
        }
      } else if (!entry.isDirectory()) {
        return undefined;
      }
      const git = await access(join(folder, ".git")).then(
        () => true,
        () => false,
      );
      return git ? { name: entry.name, git } : { name: entry.name };
    }),
  );
  const folders = found
    .filter((entry) => entry !== undefined)
    .toSorted((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base", numeric: true }),
    );
  const parent = dirname(full);
  return { path: full, ...(parent !== full ? { parent } : {}), home, folders };
}

function problem(path: string, error: unknown): string {
  switch ((error as NodeJS.ErrnoException).code) {
    case "ENOENT":
      return `There is no folder at ${path}.`;
    case "ENOTDIR":
      return `${path} is a file, not a folder.`;
    case "EACCES":
    case "EPERM":
      return `${path} can't be opened: permission denied.`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}
