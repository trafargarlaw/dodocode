import { describe, expect, test } from "vitest";
import { ago, duration } from "./time";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe("ago", () => {
  test.each<[number, string]>([
    [59_999, "now"],
    [MINUTE, "1m"],
    [59 * MINUTE, "59m"],
    [HOUR, "1h"],
    [DAY - 1, "23h"],
    [DAY, "1d"],
    [7 * DAY, "1w"],
    // A clock that moved back is not the future.
    [-5 * MINUTE, "now"],
  ])("%i ms ago is %s", (elapsed, expected) => {
    expect(ago(1_000_000_000, 1_000_000_000 + elapsed)).toBe(expected);
  });
});

describe("duration", () => {
  test.each<[number, string]>([
    [400, "0.4s"],
    [9_940, "9.9s"],
    [9_960, "10s"],
    [59_400, "59s"],
    [59_600, "1m 00s"],
    [3 * MINUTE + 5_000, "3m 05s"],
    [HOUR + 2 * MINUTE, "1h 02m"],
  ])("%i ms is %s", (ms, expected) => {
    expect(duration(ms)).toBe(expected);
  });
});
