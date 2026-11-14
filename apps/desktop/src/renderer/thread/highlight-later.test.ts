import { expect, test } from "vitest";
import { loadHighlighter } from "@dodocode/ui/lib/highlighter";
import { highlightInSlices, highlightLater, keptHighlight } from "./highlight-later";

test("highlights two lines at a time as in one piece, a comment keeping its colour past a piece's end", async () => {
  const code = "/*\n  first\n  second\n  third\n*/\nconst second = 1;";
  const whole = (await loadHighlighter("ts"))?.highlight(code).lines;
  expect(await highlightInSlices(code, "ts", () => false, 2)).toEqual(whole);
});

test("keeps what it highlighted, for the same code shown again", async () => {
  const code = "export const kept = true;";
  expect(keptHighlight(code, "ts")).toBeUndefined();
  const lines = await new Promise((done) => highlightLater(code, "ts", done));
  expect(keptHighlight(code, "ts")).toBe(lines);
  expect(keptHighlight(code, "python")).toBeUndefined();
});
