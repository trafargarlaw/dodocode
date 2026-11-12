import { expect, test, vi } from "vitest";
import { fitWithin } from "./images";

// The upload goes to the server, which a size calculation never reaches.
vi.mock("../server/connection", () => ({ server: {} }));

test.each<[string, number, number, { width: number; height: number }]>([
  ["keeps an image that fits", 1600, 900, { width: 1600, height: 900 }],
  ["keeps an image exactly at the limit", 2048, 1024, { width: 2048, height: 1024 }],
  [
    "scales a wide image to the limit, keeping its shape",
    4000,
    3000,
    { width: 2048, height: 1536 },
  ],
  ["scales a tall image by its height", 1000, 8192, { width: 250, height: 2048 }],
  ["keeps at least one pixel on the short side", 1, 10_000, { width: 1, height: 2048 }],
])("fitWithin %s", (_name, width, height, expected) => {
  expect(fitWithin(width, height, 2048)).toEqual(expected);
});
