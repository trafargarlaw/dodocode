import { expect, test } from "vitest";
import { shortcut } from "./perf";

type Press = { key: string; ctrl?: boolean; meta?: boolean; alt?: boolean; shift?: boolean };

// A trace names key presses: shortcuts by their keys, and typed text never by its characters.
test.each<[Press & { altGraph?: boolean; composing?: boolean; mac?: boolean }, string | undefined]>(
  [
    [{ key: "a" }, undefined],
    [{ key: "A", shift: true }, undefined],
    [{ key: "k", ctrl: true }, "Ctrl+K"],
    [{ key: "P", ctrl: true, shift: true }, "Ctrl+P"],
    [{ key: "Enter" }, "Enter"],
    [{ key: "Enter", shift: true }, "Shift+Enter"],
    // AltGr+0 types @ on a French keyboard, and Windows reports it as Ctrl+Alt.
    [{ key: "@", ctrl: true, alt: true, altGraph: true }, undefined],
    // On a Mac, Option types characters: Option+A types å. Elsewhere Alt+A is a shortcut.
    [{ key: "å", alt: true, mac: true }, undefined],
    [{ key: "a", alt: true }, "Alt+A"],
    [{ key: "Process", composing: true }, undefined],
  ],
)("%o is %s", (press, expected) => {
  const event = {
    key: press.key,
    ctrlKey: press.ctrl ?? false,
    metaKey: press.meta ?? false,
    altKey: press.alt ?? false,
    shiftKey: press.shift ?? false,
    isComposing: press.composing ?? false,
    getModifierState: (key: string) => key === "AltGraph" && (press.altGraph ?? false),
  };
  expect(shortcut(event, press.mac ?? false)).toBe(expected);
});
