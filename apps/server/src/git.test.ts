import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  addWorktree,
  branchName,
  changesIn,
  countChanges,
  hasChanges,
  initRepo,
  mergeBranch,
  parseDiff,
} from "./git";

describe("branch names", () => {
  test.each([
    ["Fix the login redirect loop", "fix-the-login-redirect-loop"],
    ["Ajouter l'écran « À propos »!", "ajouter-l-ecran-a-propos"],
    [
      "Show the version number in the about dialog and the settings page",
      "show-the-version-number-in-the-about",
    ],
    ["日本語のタイトル", "work"],
  ])("%s → %s", (title, name) => {
    expect(branchName(title, () => false)).toBe(name);
  });

  test("a name in use gets the next free number", () => {
    const taken = new Set(["fix-it", "fix-it-2"]);
    expect(branchName("Fix it", (name) => taken.has(name))).toBe("fix-it-3");
  });
});

test("a diff splits into one change per file, with its kind and its hunks", () => {
  const diff = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,2 +1,2 @@",
    " keep",
    "-old",
    "+new",
    "diff --git a/notes/new file.md b/notes/new file.md",
    "new file mode 100644",
    "index 0000000..3333333",
    "--- /dev/null",
    "+++ b/notes/new file.md\t",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "index 4444444..0000000",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/old.ts b/lib/moved.ts",
    "similarity index 100%",
    "rename from old.ts",
    "rename to lib/moved.ts",
    "diff --git a/logo.png b/logo.png",
    "index 5555555..6666666 100644",
    "Binary files a/logo.png and b/logo.png differ",
    "",
  ].join("\n");
  expect(parseDiff(diff)).toEqual([
    { path: "src/app.ts", kind: "update", diff: "@@ -1,2 +1,2 @@\n keep\n-old\n+new\n" },
    { path: "notes/new file.md", kind: "add", diff: "@@ -0,0 +1 @@\n+hello\n" },
    { path: "gone.txt", kind: "delete", diff: "@@ -1 +0,0 @@\n-bye\n" },
    { path: "old.ts", kind: "move", movedTo: "lib/moved.ts" },
    { path: "logo.png", kind: "update" },
  ]);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const write = (folder: string, file: string, text: string) =>
  writeFileSync(join(folder, file), text);

describe("worktrees", () => {
  let dir: string;
  let project: string;
  const saved = { ...process.env };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dodocode-git-"));
    // The person's own git config (signing, hooks, a default branch) stays out of the test.
    writeFileSync(join(dir, "gitconfig"), "");
    Object.assign(process.env, {
      GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    });
    project = join(dir, "project");
    execFileSync("git", ["init", "-q", "-b", "main", project]);
    write(project, "a.txt", "one\ntwo\n");
    write(project, "b.txt", "bee\n");
    git(project, "add", "--all");
    git(project, "commit", "-q", "-m", "start");
  });

  afterAll(() => {
    process.env = saved;
    rmSync(dir, { recursive: true, force: true });
  });

  test("a new project's repository starts with a commit, so a worktree has a base", async () => {
    const fresh = join(dir, "fresh");
    mkdirSync(fresh);
    expect(await initRepo(fresh)).toEqual({ committed: true });
    expect(git(fresh, "log", "--format=%s")).toBe("Initial commit");
  });

  test("a worktree's changes since its base count its commits, its edits and its new files", async () => {
    const tree = join(dir, "counted");
    await addWorktree(project, tree, "counted");
    write(tree, "a.txt", "one\ntwo\nthree\n");
    git(tree, "commit", "-q", "-am", "add three");
    write(tree, "b.txt", "buzz\n");
    write(tree, "c.txt", "new\nfile\n");
    // Work on main since the worktree left it is not the worktree's.
    write(project, "d.txt", "main's\n");
    git(project, "add", "d.txt");
    git(project, "commit", "-q", "-m", "main moves on");

    const { files, truncated } = await changesIn(tree, "main");
    expect(truncated).toBe(false);
    expect(files.map(({ path, kind }) => ({ path, kind }))).toEqual([
      { path: "a.txt", kind: "update" },
      { path: "b.txt", kind: "update" },
      { path: "c.txt", kind: "add" },
    ]);
    expect(files[2]!.diff).toBe("@@ -0,0 +1,2 @@\n+new\n+file\n");
    expect(await countChanges(tree, "main")).toEqual({ files: 3, added: 4, removed: 1 });
  });

  test("a merge that conflicts is taken back, and names the files", async () => {
    const tree = join(dir, "clash");
    await addWorktree(project, tree, "clash");
    write(tree, "a.txt", "one\nTWO from the branch\n");
    git(tree, "commit", "-q", "-am", "branch edit");
    write(project, "a.txt", "one\nTWO from main\n");
    git(project, "commit", "-q", "-am", "main edit");
    const head = git(project, "rev-parse", "HEAD");

    expect(await mergeBranch(project, "clash")).toEqual({ merged: false, conflicts: ["a.txt"] });
    expect(git(project, "rev-parse", "HEAD")).toBe(head);
    expect(await hasChanges(project)).toBe(false);
    expect(readFileSync(join(project, "a.txt"), "utf8")).toBe("one\nTWO from main\n");
  });
});
