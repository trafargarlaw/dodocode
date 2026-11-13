import { expect, test } from "vitest";
import { mix, type Rgb } from "./color";

// Expected mixes are Chrome's: `color-mix(in oklab, ...)` drawn to a canvas and read back.
test.each<[string, Rgb, Rgb, number, Rgb]>([
  ["the start colour at 0", [250, 179, 205], [20, 40, 160], 0, [250, 179, 205]],
  ["the end colour at 1", [250, 179, 205], [20, 40, 160], 1, [20, 40, 160]],
  ["mid grey between white and black", [255, 255, 255], [0, 0, 0], 0.5, [99, 99, 99]],
  ["purple between red and blue", [255, 0, 0], [0, 0, 255], 0.5, [140, 83, 162]],
])("mix gives %s", (_, from, to, amount, expected) => {
  expect(mix(from, to, amount)).toEqual(expected);
});
