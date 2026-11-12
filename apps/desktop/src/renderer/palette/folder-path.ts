// The path typed in the folder browser: the folder it lists, and the name being typed in it.
// Written with forward slashes on every system, and `~` for the home folder.

export interface TypedPath {
  /** The folder to list, as typed up to its last slash. */
  folder: string;
  /** What was typed after the last slash, which narrows the list. */
  filter: string;
}

/** Splits what was typed into the folder to list and the name being typed in it. */
export function splitTyped(typed: string): TypedPath {
  const text = typed.replaceAll("\\", "/");
  // A drive letter alone, or `~` alone, is that folder, with nothing typed in it yet.
  if (/^[a-z]:$/i.test(text) || text === "~") return { folder: `${text}/`, filter: "" };
  const cut = text.lastIndexOf("/");
  if (cut < 0) return { folder: "~/", filter: text };
  return { folder: text.slice(0, cut + 1), filter: text.slice(cut + 1) };
}

// Windows doesn't mind the case of a path, so neither does `~`.
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** A folder's path as the browser shows it: forward slashes, `~` for home, a slash at the end. */
export function showPath(path: string, home: string): string {
  const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "");
  const homeSlashed = home.replaceAll("\\", "/").replace(/\/+$/, "");
  if (homeSlashed && same(slashed, homeSlashed)) return "~/";
  if (homeSlashed && same(slashed.slice(0, homeSlashed.length + 1), `${homeSlashed}/`)) {
    return `~/${slashed.slice(homeSlashed.length + 1)}/`;
  }
  return `${slashed}/`;
}

/**
 * The folders whose names fit what was typed: those that start with it first, then those that
 * have it anywhere. A name starting with a dot shows only when what was typed does too.
 */
export function matchFolders<T extends { name: string }>(
  folders: readonly T[],
  filter: string,
): T[] {
  const wanted = filter.toLowerCase();
  const shown = wanted.startsWith(".")
    ? folders
    : folders.filter((folder) => !folder.name.startsWith("."));
  if (!wanted) return [...shown];
  const starts = shown.filter((folder) => folder.name.toLowerCase().startsWith(wanted));
  const has = shown.filter(
    (folder) =>
      !folder.name.toLowerCase().startsWith(wanted) && folder.name.toLowerCase().includes(wanted),
  );
  return [...starts, ...has];
}

/**
 * The path one folder up from a typed one that ends in a slash, worked out from the text alone.
 * Nothing at the top of a drive, or at `~`, whose folder only the server knows.
 */
export function upFrom(shown: string): string | undefined {
  const trimmed = shown.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  if (cut < 0) return undefined;
  return trimmed.slice(0, cut + 1);
}

/** The last part of a shown path, which names the folder: `~/code/app/` is `app`, `~/` is `~`. */
export function folderName(shown: string): string {
  const trimmed = shown.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || "/";
}

/**
 * The folder a full path is in, written the way the path is: `C:\a\b` is in `C:\a`, and `C:\a` in
 * `C:\`. Nothing for the top of a drive or the disk.
 */
export function parentOf(path: string): string | undefined {
  const trimmed = path.replace(/[/\\]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return undefined;
  const parent = trimmed.slice(0, cut);
  const slash = trimmed.charAt(cut);
  // The top of a drive, or of the disk, keeps its slash.
  if (/^[a-z]:$/i.test(parent)) return `${parent}${slash}`;
  return parent || slash;
}

/** A folder inside a full path, joined with the path's own slash. */
export function childPath(parent: string, name: string): string {
  const slash = parent.includes("\\") ? "\\" : "/";
  return parent.endsWith(slash) ? `${parent}${name}` : `${parent}${slash}${name}`;
}

/** Whether two full paths name the same folder. Windows paths ignore case and slash style. */
export function samePath(a: string, b: string): boolean {
  const windows = /^[a-z]:/i.test(a) || /^[a-z]:/i.test(b);
  const tidy = (path: string) => {
    const slashed = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return windows ? slashed.toLowerCase() : slashed;
  };
  return tidy(a) === tidy(b);
}
