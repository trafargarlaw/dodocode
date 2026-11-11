import { describe, expect, test } from "vitest";
import { addColor, moveColor, removeColor } from "./linked-colors";

const colors = (...pairs: (readonly [hue: number, strength: number])[]) =>
  pairs.map(([hue, strength]) => ({ hue, strength }));

describe("moveColor", () => {
  test.each([
    [
      "keeps the hue gap and the share of the strength",
      [
        [350, 0.8],
        [300, 0.4],
      ],
      [20, 0.4],
      [
        [20, 0.4],
        [330, 0.2],
      ],
    ],
    [
      "wraps a hue past 360",
      [
        [10, 0.5],
        [340, 0.5],
      ],
      [40, 0.5],
      [
        [40, 0.5],
        [10, 0.5],
      ],
    ],
    [
      "wraps a hue below 0",
      [
        [10, 0.5],
        [340, 0.5],
      ],
      [-20, 0.5],
      [
        [340, 0.5],
        [310, 0.5],
      ],
    ],
    [
      "stops a colour at full strength",
      [
        [0, 0.5],
        [60, 1],
      ],
      [0, 0.8],
      [
        [0, 0.8],
        [60, 1],
      ],
    ],
    [
      "brings colours out of the centre with the lead",
      [
        [0, 0],
        [120, 0],
      ],
      [90, 0.6],
      [
        [90, 0.6],
        [210, 0.6],
      ],
    ],
  ] as const)("the lead carries the others: %s", (_, start, [hue, strength], expected) => {
    expect(moveColor(colors(...start), 0, { hue, strength })).toEqual(colors(...expected));
  });

  test("any other colour moves alone, inside the wheel", () => {
    expect(
      moveColor(colors([0, 0.5], [120, 0.5], [240, 0.5]), 1, { hue: 380, strength: 1.4 }),
    ).toEqual(colors([0, 0.5], [20, 1], [240, 0.5]));
  });
});

describe("addColor and removeColor", () => {
  test("adds a colour a third of the wheel on from the last, up to three", () => {
    const three = addColor(colors([300, 0.7], [310, 0.2]));
    expect(three).toEqual(colors([300, 0.7], [310, 0.2], [70, 0.7]));
    expect(addColor(three)).toEqual(three);
  });

  test("removes the last colour but never the only one", () => {
    expect(removeColor(colors([0, 0.5], [120, 0.5]))).toEqual(colors([0, 0.5]));
    expect(removeColor(colors([0, 0.5]))).toEqual(colors([0, 0.5]));
  });
});
