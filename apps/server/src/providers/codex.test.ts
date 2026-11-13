import { expect, test } from "vitest";

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
