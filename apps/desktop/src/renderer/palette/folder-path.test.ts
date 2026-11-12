import { expect, test } from "vitest";

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

test.each([
  ["~/code/da", { folder: "~/code/", filter: "da" }],
  ["C:\\Users\\", { folder: "C:/Users/", filter: "" }],
  ["C:", { folder: "C:/", filter: "" }],
  ["~", { folder: "~/", filter: "" }],
  ["proj", { folder: "~/", filter: "proj" }],
])("typing %j lists %o", (typed, split) => {
  expect(splitTyped(typed)).toEqual(split);
});

test.each([
  ["C:\\Users\\me", "~/"],
  ["c:\\users\\me\\Code", "~/Code/"],
  ["C:\\Users\\meg", "C:/Users/meg/"],
  ["D:\\", "D:/"],
])("the folder %s shows as %s", (path, shown) => {
  expect(showPath(path, "C:\\Users\\me")).toBe(shown);
});

test("folders that start with what was typed come first, and dot folders show only for a dot", () => {
  const folders = [".git", "app", "my-app", "Apple", "docs"].map((name) => ({ name }));
  const names = (filter: string) => matchFolders(folders, filter).map((folder) => folder.name);
  expect(names("app")).toEqual(["app", "Apple", "my-app"]);
  expect(names("")).toEqual(["app", "my-app", "Apple", "docs"]);
  expect(names(".")).toEqual([".git"]);
});

test.each([
  ["~/Desktop/code/", "~/Desktop/"],
  ["C:/Users/", "C:/"],
  ["/home/", "/"],
  ["~/", undefined],
  ["C:/", undefined],
  ["/", undefined],
])("up from %s is %s", (shown, up) => {
  expect(upFrom(shown)).toBe(up);
});

test.each([
  ["~/code/app/", "app"],
  ["~/", "~"],
  ["C:/", "C:"],
  ["/", "/"],
])("the folder %s is named %s", (shown, name) => {
  expect(folderName(shown)).toBe(name);
});

test.each([
  ["C:\\a\\b", "C:\\a"],
  ["C:\\a", "C:\\"],
  ["/home/me/", "/home"],
  ["/home", "/"],
  ["C:\\", undefined],
])("%s is in %s", (path, parent) => {
  expect(parentOf(path)).toBe(parent);
});

test.each([
  ["C:\\", "C:\\app"],
  ["C:\\code", "C:\\code\\app"],
  ["/home/me", "/home/me/app"],
  ["/", "/app"],
])("app in %s is %s", (parent, path) => {
  expect(childPath(parent, "app")).toBe(path);
});

test.each([
  ["C:\\Code\\App", "c:/code/app/", true],
  ["/home/me/app/", "/home/me/app", true],
  ["/home/me/App", "/home/me/app", false],
])("%s and %s are the same folder: %s", (a, b, same) => {
  expect(samePath(a, b)).toBe(same);
});
