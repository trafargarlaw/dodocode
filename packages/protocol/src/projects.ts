// What the server and the window both work out about a new project's folder.

/** Names Windows keeps for devices, which no folder can have there. */
const RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

/** Why a new folder can't have this name, or nothing when it can. */
export function folderNameProblem(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Give it a name.";
  if (trimmed === "." || trimmed === "..") return "That name is taken by the system.";
  // Control characters are among those it turns away.
  // oxlint-disable-next-line no-control-regex
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) {
    return "A folder name can't have any of < > : \" / \\ | ? *";
  }
  if (/[. ]$/.test(trimmed)) return "A folder name can't end with a dot or a space.";
  if (RESERVED.test(trimmed)) return `Windows keeps ${trimmed} for itself.`;
  if (trimmed.length > 200) return "That name is too long.";
  return undefined;
}

/**
 * The URL to clone a GitHub repository from: `owner/repo`, or a github.com address, as an
 * HTTPS URL. Nothing when it names no repository.
 */
export function githubUrl(input: string): string | undefined {
  const text = input
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?github\.com[/:]/i, "")
    .replace(/^git@github\.com:/i, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const match = /^([\w.-]+)\/([\w.-]+)$/.exec(text);
  if (!match) return undefined;
  return `https://github.com/${match[1]}/${match[2]}.git`;
}

/**
 * The folder a clone of `url` goes in: the repository's name, without `.git`. Nothing when the
 * URL names no repository.
 */
export function repoName(url: string): string | undefined {
  const path = url
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/[/\\]+$/, "")
    .replace(/\.git$/i, "");
  // The last part of the path, after a slash, or after the colon of `git@host:owner/repo`.
  const name = /[^/\\:]+$/.exec(path)?.[0];
  if (!name || name === path) return undefined;
  return folderNameProblem(name) ? undefined : name;
}
