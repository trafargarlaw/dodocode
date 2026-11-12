import { expect, test } from "vitest";
import type { SlashCommand } from "@dodocode/protocol";
import { commandMatches } from "./slash-commands";

const commands: SlashCommand[] = [
  { name: "context", description: "" },
  { name: "compact", description: "" },
  { name: "autocompact", description: "", argumentHint: "[auto|<tokens>]" },
  { name: "review", description: "" },
];

test.each<[string, string, string[] | undefined]>([
  ["a slash alone offers every command", "/", ["autocompact", "compact", "context", "review"]],
  ["names that start with the words come first", "/comp", ["compact", "autocompact"]],
  ["case does not matter", "/REV", ["review"]],
  ["words that start no name offer none", "/zzz", []],
  ["a command with its argument shuts the menu", "/autocompact 150000", undefined],
  ["words without a slash shut it", "compact", undefined],
  ["a slash after other words shuts it", "see /compact", undefined],
])("commandMatches: %s", (_, text, expected) => {
  expect(commandMatches(commands, text)?.map((command) => command.name)).toEqual(expected);
});
