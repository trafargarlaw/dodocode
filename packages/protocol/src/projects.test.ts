import { expect, test } from "vitest";

import { folderNameProblem, githubUrl, repoName } from "./projects";

test.each([
  ["my-app", true],
  ["  ", false],
  ["..", false],
  ["a:b", false],
  ["notes.", false],
  ["con", false],
  ["com1.txt", false],
  ["console", true],
  ["x".repeat(200), true],
  ["x".repeat(201), false],
])("a folder can be named %j: %s", (name, ok) => {
  expect(folderNameProblem(name) === undefined).toBe(ok);
});

test.each([
  ["vercel/next.js", "https://github.com/vercel/next.js.git"],
  ["https://github.com/vercel/next.js", "https://github.com/vercel/next.js.git"],
  ["git@github.com:vercel/next.js.git", "https://github.com/vercel/next.js.git"],
  ["github.com/vercel/next.js/", "https://github.com/vercel/next.js.git"],
  ["vercel", undefined],
  ["https://github.com/vercel/next.js/tree/main", undefined],
  ["https://gitlab.com/team/app", undefined],
])("the GitHub repository %j clones from %s", (input, url) => {
  expect(githubUrl(input)).toBe(url);
});

test.each([
  ["https://github.com/vercel/next.js.git", "next.js"],
  ["git@gitlab.com:team/app.git", "app"],
  ["https://example.com/repo?ref=main#top", "repo"],
  ["https://example.com/repo/", "repo"],
  ["C:\\repos\\app", "app"],
  ["repo", undefined],
  ["https://example.com/con.git", undefined],
])("a clone of %j goes in the folder %s", (url, name) => {
  expect(repoName(url)).toBe(name);
});
