import { expect, test } from "vitest";

import { toolsAtStart } from "./codex";
import { shownCommand } from "./codex-items";

test.each([
  [
    String.raw`"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" -Command "Set-Content -LiteralPath 'hello.txt' -Value 'hi'"`,
    "Set-Content -LiteralPath 'hello.txt' -Value 'hi'",
  ],
  [`pwsh.exe -NoProfile -Command "Get-ChildItem"`, "Get-ChildItem"],
  [`/bin/bash -lc 'ls -la && echo "x"'`, `ls -la && echo "x"`],
  ["cmd.exe /c dir", "dir"],
  ["git status", "git status"],
])("a command shows without the shell Codex wraps it in: %s", (command, shown) => {
  expect(shownCommand(command)).toBe(shown);
});

test.each([
  [
    JSON.stringify({ type: "session_meta", payload: { dynamic_tools: [{ name: "move_task" }] } }),
    ["move_task"],
  ],
  // Codex leaves the field out for a thread that started with none.
  [JSON.stringify({ type: "session_meta", payload: { originator: "codex_exec" } }), []],
  [JSON.stringify({ type: "response_item", payload: {} }), undefined],
  ['{"type":"session_meta","payload":{"dynamic_', undefined],
])("the tools a Codex thread started with, from its saved file's first line: %s", (line, tools) => {
  expect(toolsAtStart(line)).toEqual(tools);
});
