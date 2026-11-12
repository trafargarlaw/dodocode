import { expect, test } from "vitest";
import { searchScore } from "./search-match";

const entry = ["Fix the login bug", "dodocode"];

test.each<[string, string, number]>([
  ["shows everything before anything is typed", "  ", 1],
  ["ranks an entry first when its first word starts with the search", "fix", 1],
  ["matches words in any order, in any case", "BUG login", 0.5],
  ["matches the project's name too", "dodo", 0.5],
  ["hides an entry missing one of the words", "login crash", 0],
])("%s", (_name, search, expected) => {
  expect(searchScore(entry, search)).toBe(expected);
});
