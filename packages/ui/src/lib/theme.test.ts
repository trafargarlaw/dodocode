import { describe, expect, test } from "vitest";
import {
  DEFAULT_THEME,
  PRESETS,
  deriveTheme,
  parseThemeSettings,
  stepPreset,
  type ColorScheme,
  type ThemeSettings,
} from "./theme";

// WCAG 2.2 contrast, written out from the spec so the test does not reuse the code it checks.
function luminance(hex: string): number {
  const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [light = 0, dark = 0] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

// --background in globals.css: oklch(1 0 0) and oklch(0.145 0 0).
const SHEET: Record<ColorScheme, string> = { light: "#ffffff", dark: "#0a0a0a" };

const pick = (colors: [hue: number, strength: number][], intensity = 1): ThemeSettings => ({
  appearance: "system",
  colors: colors.map(([hue, strength]) => ({ hue, strength })),
  intensity,
  angle: 135,
});

// The hardest picks: full-strength yellow and blue (the lightest and darkest hues), grey, and
// three clashing colours. Every preset is checked too.
const picks: [string, ThemeSettings][] = [
  ["yellow", pick([[100, 1]])],
  ["blue", pick([[265, 1]])],
  ["grey", pick([[0, 0]], 0)],
  [
    "three colours",
    pick([
      [100, 1],
      [265, 1],
      [25, 1],
    ]),
  ],
  ...PRESETS.map((preset): [string, ThemeSettings] => [
    preset.name,
    { ...preset, appearance: "system" },
  ]),
];

describe("deriveTheme", () => {
  test.each(
    picks.flatMap(([name, settings]) =>
      (["light", "dark"] as const).map((scheme) => ({ name, settings, scheme })),
    ),
  )("$name in $scheme passes every contrast floor", ({ settings, scheme }) => {
    const theme = deriveTheme(settings, scheme);
    for (const stop of theme.wallpaperColors) {
      expect(ratio(theme.text, stop)).toBeGreaterThanOrEqual(7);
      expect(ratio(theme.mutedText, stop)).toBeGreaterThanOrEqual(4.5);
      expect(ratio(theme.primaryInk, stop)).toBeGreaterThanOrEqual(4.5);
    }
    expect(ratio(theme.primaryInk, SHEET[scheme])).toBeGreaterThanOrEqual(4.5);
    expect(ratio(theme.primaryForeground, theme.primary)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("parseThemeSettings", () => {
  test.each<[string, unknown, ThemeSettings]>([
    ["nothing saved", null, DEFAULT_THEME],
    ["only an appearance", { appearance: "dark" }, { ...DEFAULT_THEME, appearance: "dark" }],
    ["no valid colours", { colors: [{ hue: "red" }] }, DEFAULT_THEME],
    [
      "values out of range",
      {
        appearance: "sepia",
        colors: [
          { hue: 400, strength: 2 },
          { hue: -30, strength: -1 },
          { hue: 10, strength: 0.5 },
          { hue: 20, strength: 0.5 },
        ],
        intensity: 3,
        angle: -45,
      },
      {
        appearance: "system",
        colors: [
          { hue: 40, strength: 1 },
          { hue: 330, strength: 0 },
          { hue: 10, strength: 0.5 },
        ],
        intensity: 1,
        angle: 315,
      },
    ],
  ])("%s", (_, saved, expected) => {
    expect(parseThemeSettings(saved)).toEqual(expected);
  });
});

function presetAt(index: number) {
  const preset = PRESETS.at(index);
  if (!preset) throw new Error(`No preset at ${index}`);
  return preset;
}

describe("stepPreset", () => {
  const [first, second, last] = [presetAt(0), presetAt(1), presetAt(-1)];
  const custom = { ...DEFAULT_THEME, angle: DEFAULT_THEME.angle + 1 };
  test.each([
    ["the next preset", first, 1, second],
    ["round from the last to the first", last, 1, first],
    ["round from the first to the last", first, -1, last],
    ["from custom settings forwards to the first", custom, 1, first],
    ["from custom settings backwards to the last", custom, -1, last],
  ] as const)("steps to %s", (_, from, step, expected) => {
    expect(stepPreset({ appearance: "dark", ...from }, step)).toBe(expected);
  });
});
