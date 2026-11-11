// A theme changes the app's colours and nothing else: fonts, sizes, spacing and the reading sheet
// stay fixed. The person picks wallpaper colours; text and accent colours are derived from them
// so that they always pass WCAG contrast, whatever was picked.
import { blend, contrast, oklch, toCss, toHex, type Rgb } from "./color";

export type ColorScheme = "light" | "dark";
export type Appearance = ColorScheme | "system";

/** One wallpaper colour, as a point on the colour wheel. */
export interface WallpaperColor {
  /** Hue in degrees, 0–360. */
  hue: number;
  /** From grey (0) to as colourful as a wallpaper gets (1). */
  strength: number;
}

/**
 * What the person picks. Lightness is not part of it: the colour scheme decides lightness, so one
 * set of settings works in light and in dark.
 */
export interface ThemeSettings {
  appearance: Appearance;
  /** One to `MAX_COLORS` colours. */
  colors: readonly WallpaperColor[];
  /** Scales the strength of every colour, 0–1. */
  intensity: number;
  /** Direction of the gradient in degrees, 0–360. */
  angle: number;
}

export interface Preset extends Omit<ThemeSettings, "appearance"> {
  name: string;
}

/** The colours the app needs, as CSS colours. Every text colour is checked against its backgrounds. */
export interface Theme {
  scheme: ColorScheme;
  /** CSS background for the window. */
  wallpaper: string;
  /** The wallpaper's colour stops. */
  wallpaperColors: readonly string[];
  /** Text on the wallpaper, at least 7:1 on every part of it, hovered and selected rows included. */
  text: string;
  /** Secondary text on the wallpaper, at least 4.5:1. */
  mutedText: string;
  /** Translucent fill for a hovered row on the wallpaper. */
  hover: string;
  /** Translucent fill for a selected row on the wallpaper. */
  selected: string;
  /** Lines on the wallpaper. */
  border: string;
  /** The accent fill, for buttons. */
  primary: string;
  /** A label on the accent fill, at least 4.5:1. */
  primaryForeground: string;
  /** The accent as text or a dot, at least 4.5:1 on the sheet and on the wallpaper. */
  primaryInk: string;
}

export const MAX_COLORS = 3;

function preset(
  name: string,
  colors: [hue: number, strength: number][],
  angle: number,
  intensity: number,
): Preset {
  return { name, colors: colors.map(([hue, strength]) => ({ hue, strength })), angle, intensity };
}

const SUNSET = preset(
  "Sunset",
  [
    [355, 0.8],
    [62, 0.9],
  ],
  135,
  0.85,
);

export const PRESETS: readonly Preset[] = [
  SUNSET,
  preset(
    "Lagoon",
    [
      [240, 0.85],
      [175, 0.8],
    ],
    160,
    0.85,
  ),
  preset(
    "Matcha",
    [
      [135, 0.7],
      [95, 0.55],
    ],
    150,
    0.75,
  ),
  preset(
    "Lilac",
    [
      [305, 0.8],
      [350, 0.65],
      [255, 0.6],
    ],
    120,
    0.8,
  ),
  preset(
    "Dusk",
    [
      [25, 0.85],
      [300, 0.75],
      [255, 0.8],
    ],
    200,
    0.8,
  ),
  preset(
    "Peach",
    [
      [40, 0.8],
      [75, 0.7],
    ],
    110,
    0.8,
  ),
  preset(
    "Graphite",
    [
      [260, 0.3],
      [260, 0.1],
    ],
    135,
    0.15,
  ),
  preset(
    "Rose",
    [
      [5, 0.8],
      [330, 0.65],
    ],
    135,
    0.8,
  ),
  preset(
    "Citrus",
    [
      [95, 0.85],
      [60, 0.8],
    ],
    120,
    0.85,
  ),
  preset(
    "Mint",
    [
      [165, 0.75],
      [200, 0.6],
    ],
    140,
    0.75,
  ),
  preset(
    "Ocean",
    [
      [255, 0.9],
      [215, 0.7],
      [285, 0.6],
    ],
    170,
    0.9,
  ),
  preset(
    "Aurora",
    [
      [150, 0.8],
      [220, 0.8],
      [290, 0.7],
    ],
    200,
    0.85,
  ),
  preset(
    "Sand",
    [
      [80, 0.35],
      [55, 0.3],
    ],
    135,
    0.5,
  ),
  preset(
    "Slate",
    [
      [230, 0.4],
      [250, 0.25],
    ],
    150,
    0.4,
  ),
];

export const DEFAULT_THEME: ThemeSettings = {
  appearance: "system",
  colors: SUNSET.colors,
  intensity: SUNSET.intensity,
  angle: SUNSET.angle,
};

// WCAG floors: 7:1 (AAA) for text people read, 4.5:1 (AA) for secondary text and labels.
const TEXT_FLOOR = 7;
const SMALL_FLOOR = 4.5;

const WALLPAPER_CHROMA = 0.12; // a colour at full strength and intensity
const ACCENT_CHROMA = 0.17;
const NEUTRAL_BELOW = 0.015; // a wallpaper less colourful than this gets a neutral accent
const WHITE = oklch(1, 0, 0);
const NEAR_BLACK = oklch(0.18, 0, 0);

const SCHEMES = {
  light: {
    wallpaperLightness: 0.86,
    sheet: oklch(1, 0, 0), // --background in globals.css
    hoverAlpha: 0.45,
    selectedAlpha: 0.85,
    textLightness: 0.27,
    mutedLightness: 0.47,
    accentLightness: 0.64,
    towardsContrast: -0.01, // dark text on a light wallpaper gets darker
    tint: 0.025,
  },
  dark: {
    wallpaperLightness: 0.31,
    sheet: oklch(0.145, 0, 0), // --background in globals.css
    hoverAlpha: 0.06,
    selectedAlpha: 0.1,
    textLightness: 0.95,
    mutedLightness: 0.76,
    accentLightness: 0.74,
    towardsContrast: 0.01,
    tint: 0.0125,
  },
} as const;

/** A wallpaper colour as it shows in a colour scheme. */
export function wallpaperColor(color: WallpaperColor, intensity: number, scheme: ColorScheme): Rgb {
  const chroma = color.strength * intensity * WALLPAPER_CHROMA;
  return oklch(SCHEMES[scheme].wallpaperLightness, chroma, color.hue);
}

export function deriveTheme(settings: ThemeSettings, scheme: ColorScheme): Theme {
  const s = SCHEMES[scheme];
  const colors = settings.colors.length > 0 ? settings.colors : DEFAULT_THEME.colors;
  const stops = colors.map((color) => wallpaperColor(color, settings.intensity, scheme));

  // The boldest colour leads: it tints the text and gives the accent its hue.
  const lead = colors.reduce((a, b) => (b.strength > a.strength ? b : a));
  const neutral = lead.strength * settings.intensity * WALLPAPER_CHROMA < NEUTRAL_BELOW;
  const hue = neutral ? undefined : lead.hue;

  // Text on the wallpaper has to read on bare wallpaper and on hovered and selected rows.
  const backgrounds = stops.flatMap((stop) => [
    stop,
    blend(WHITE, s.hoverAlpha, stop),
    blend(WHITE, s.selectedAlpha, stop),
  ]);
  const tint = neutral ? 0 : s.tint;
  const text = readable(s.textLightness, s.towardsContrast, tint, hue, backgrounds, TEXT_FLOOR);
  const mutedText = readable(
    s.mutedLightness,
    s.towardsContrast,
    tint,
    hue,
    backgrounds,
    SMALL_FLOOR,
  );
  const { fill, label } = accent(hue, scheme);
  const ink = readable(
    s.accentLightness,
    s.towardsContrast,
    neutral ? 0 : ACCENT_CHROMA,
    hue,
    [s.sheet, ...backgrounds],
    SMALL_FLOOR,
  );

  return {
    scheme,
    wallpaper: wallpaperCss(stops, settings.angle),
    wallpaperColors: stops.map(toHex),
    text: toHex(text),
    mutedText: toHex(mutedText),
    hover: toCss(WHITE, s.hoverAlpha),
    selected: toCss(WHITE, s.selectedAlpha),
    border: toCss(text, 0.14),
    primary: toHex(fill),
    primaryForeground: toHex(label),
    primaryInk: toHex(ink),
  };
}

/**
 * Walks lightness from `start` by `step` until the colour reaches `floor` against every background.
 * Ends at black or white if it never does.
 */
function readable(
  start: number,
  step: number,
  chroma: number,
  hue: number | undefined,
  backgrounds: readonly Rgb[],
  floor: number,
): Rgb {
  for (let lightness = start; ; lightness += step) {
    const color = oklch(lightness, hue === undefined ? 0 : chroma, hue ?? 0);
    const worst = Math.min(...backgrounds.map((background) => contrast(color, background)));
    if (worst >= floor || lightness <= 0 || lightness >= 1) return color;
  }
}

function accent(hue: number | undefined, scheme: ColorScheme): { fill: Rgb; label: Rgb } {
  if (hue === undefined) {
    return scheme === "light"
      ? { fill: oklch(0.27, 0, 0), label: WHITE }
      : { fill: oklch(0.93, 0, 0), label: NEAR_BLACK };
  }
  const start = SCHEMES[scheme].accentLightness;
  if (scheme === "light") {
    // A white label needs a darker fill. Darkened further than this the colour turns muddy, so
    // yellows and greens keep their brightness and take a dark label instead.
    for (let lightness = start; lightness >= start - 0.1 - 1e-9; lightness -= 0.01) {
      const fill = oklch(lightness, ACCENT_CHROMA, hue);
      if (contrast(fill, WHITE) >= SMALL_FLOOR) return { fill, label: WHITE };
    }
  }
  const fill = readable(start, 0.01, ACCENT_CHROMA, hue, [NEAR_BLACK], SMALL_FLOOR);
  return { fill, label: NEAR_BLACK };
}

function wallpaperCss(stops: readonly Rgb[], angle: number): string {
  const [first, second] = stops;
  if (!first || !second) return toCss(first ?? WHITE);
  // Each colour glows in from its own side of the window, and the angle turns them together.
  const glows = stops.map((stop, i) => {
    const turn = ((angle + 180 + (i * 360) / stops.length) * Math.PI) / 180;
    const x = (50 + 58 * Math.sin(turn)).toFixed(1);
    const y = (50 - 58 * Math.cos(turn)).toFixed(1);
    return `radial-gradient(farthest-side at ${x}% ${y}% in oklab, ${toCss(stop)}, ${toCss(stop, 0)} 90%)`;
  });
  const base =
    stops.length === 2
      ? `linear-gradient(${angle}deg in oklab, ${toCss(first)}, ${toCss(second)})`
      : toCss(average(stops));
  return [...glows, base].join(", ");
}

function average(colors: readonly Rgb[]): Rgb {
  const mean = (channel: 0 | 1 | 2) =>
    Math.round(colors.reduce((sum, color) => sum + color[channel], 0) / colors.length);
  return [mean(0), mean(1), mean(2)];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);
const toDegrees = (value: number) => ((value % 360) + 360) % 360;
const toUnit = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Settings read back from storage. A missing or invalid field takes its default, and numbers are
 * brought into range.
 */
export function parseThemeSettings(value: unknown): ThemeSettings {
  if (!isRecord(value)) return DEFAULT_THEME;
  const colors = Array.isArray(value.colors)
    ? value.colors
        .flatMap((color: unknown) =>
          isRecord(color) && isNumber(color.hue) && isNumber(color.strength)
            ? [{ hue: toDegrees(color.hue), strength: toUnit(color.strength) }]
            : [],
        )
        .slice(0, MAX_COLORS)
    : [];
  const { appearance } = value;
  return {
    appearance:
      appearance === "system" || appearance === "light" || appearance === "dark"
        ? appearance
        : DEFAULT_THEME.appearance,
    colors: colors.length > 0 ? colors : DEFAULT_THEME.colors,
    intensity: isNumber(value.intensity) ? toUnit(value.intensity) : DEFAULT_THEME.intensity,
    angle: isNumber(value.angle) ? toDegrees(value.angle) : DEFAULT_THEME.angle,
  };
}

const same = (a: number, b: number) => Math.abs(a - b) < 1e-6;

/** The preset these settings come from, unless they were changed after it was picked. */
export function findPreset(settings: ThemeSettings): Preset | undefined {
  return PRESETS.find(
    (candidate) =>
      same(candidate.intensity, settings.intensity) &&
      same(candidate.angle, settings.angle) &&
      candidate.colors.length === settings.colors.length &&
      candidate.colors.every((color, i) => {
        const other = settings.colors[i];
        return (
          other !== undefined && same(color.hue, other.hue) && same(color.strength, other.strength)
        );
      }),
  );
}

/**
 * The preset `step` places on from the one these settings come from, wrapping round the list.
 * Custom settings step to the first preset forwards and to the last backwards.
 */
export function stepPreset(settings: ThemeSettings, step: 1 | -1): Preset {
  const current = findPreset(settings);
  const from = current ? PRESETS.indexOf(current) : step > 0 ? -1 : PRESETS.length;
  const next = PRESETS[(from + step + PRESETS.length) % PRESETS.length];
  if (!next) throw new Error("There are no presets.");
  return next;
}
