import { expect, test } from "vitest";
import { hunkHeading, languageOf, splitPath } from "./diff";

test.each([
  ["apps/desktop/src/thread-view.tsx", "tsx"],
  ["scripts\\build.MJS", "js"],
  ["Makefile", "text"],
  [".env", "text"],
  ["v1.2/README", "text"],
])("languageOf(%s) is %s", (path, language) => {
  expect(languageOf(path)).toBe(language);
});

test.each([
  ["apps/desktop/main.ts", { folder: "apps/desktop/", name: "main.ts" }],
  ["src\\a.ts", { folder: "src\\", name: "a.ts" }],
  ["package.json", { folder: "", name: "package.json" }],
])("splitPath(%s)", (path, parts) => {
  expect(splitPath(path)).toEqual(parts);
});

test.each([
  [
    "@@ -140,6 +142,14 @@ ipcMain.handle(PICK_FOLDER_CHANNEL, async",
    "ipcMain.handle(PICK_FOLDER_CHANNEL, async",
  ],
  ["@@ -1 +1 @@", ""],
])("hunkHeading(%s)", (header, heading) => {
  expect(hunkHeading(header)).toBe(heading);
});
