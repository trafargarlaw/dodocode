import { describe, expect, test } from "vitest";
import { compact, cost } from "./numbers";

describe("compact", () => {
  test.each<[number, string]>([
    [950, "950"],
    [1000, "1k"],
    [12_345, "12.3k"],
    [99_960, "100k"],
    [123_456, "123k"],
    [999_950, "1M"],
    [1_250_000, "1.3M"],
  ])("%i reads %s", (count, expected) => {
    expect(compact(count)).toBe(expected);
  });
});

describe("cost", () => {
  test.each<[number, string]>([
    [0.00049, "<$0.001"],
    [0.0042, "$0.004"],
    [0.00996, "$0.01"],
    [0.01, "$0.01"],
    [1.234, "$1.23"],
  ])("$%d reads %s", (usd, expected) => {
    expect(cost(usd)).toBe(expected);
  });
});
