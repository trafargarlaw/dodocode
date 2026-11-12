import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { expandPath, listFolders } from "./folders";

const home = resolve(tmpdir(), "dodocode-home");

test.each([
  ["", home],
  ["~", home],
  ["~/code", join(home, "code")],
  ["~\\code", join(home, "code")],
  ["code", join(home, "code")],
  [resolve(home, "..", "elsewhere"), resolve(home, "..", "elsewhere")],
])("the path %j is %s", (typed, full) => {
  expect(expandPath(typed, home)).toBe(full);
});

test.runIf(process.platform === "win32")("a drive letter alone is the top of that drive", () => {
  expect(expandPath("D:", home)).toBe("D:\\");
});

describe("listing a folder", () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "dodocode-folders-"));
    for (const name of ["b", "A", "a10", "a9", ".hidden", "repo/.git"]) {
      mkdirSync(join(dir, name), { recursive: true });
    }
    writeFileSync(join(dir, "notes.txt"), "");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("lists only folders, by name with numbers in order, and marks repositories", async () => {
    const listing = await listFolders(dir, home);
    expect(listing).toEqual({
      path: dir,
      parent: dirname(dir),
      home,
      folders: [
        { name: ".hidden" },
        { name: "A" },
        { name: "a9" },
        { name: "a10" },
        { name: "b" },
        { name: "repo", git: true },
      ],
    });
  });

  test("says when the path is missing or a file", async () => {
    await expect(listFolders(join(dir, "missing"), home)).rejects.toThrow("There is no folder at");
    await expect(listFolders(join(dir, "notes.txt"), home)).rejects.toThrow(
      "is a file, not a folder",
    );
  });
});
