import { join, resolve } from "node:path";
import { expect, test } from "vitest";
import { fileInFolder } from "./web-files";

const folder = resolve("pages", "mock");

test.each<[string, string, string | undefined]>([
  ["a file beside the page", "style.css", join(folder, "style.css")],
  ["a file in a folder beside it", "assets/logo.png", join(folder, "assets", "logo.png")],
  ["a path out of the folder", "../secrets.txt", undefined],
  ["a path that climbs out from a folder beside it", "assets/../../other/a.css", undefined],
  ["an absolute path", resolve("elsewhere", "x.png"), undefined],
  ["a hidden file", ".env", undefined],
  ["a file in a hidden folder", ".git/config", undefined],
  ["the folder itself", ".", undefined],
  ["a path with a NUL", "style.css\0.png", undefined],
])("fileInFolder: %s", (_, path, expected) => {
  expect(fileInFolder(folder, path)).toBe(expected);
});
