// The colour maths themes need: OKLCH to sRGB, mixing, blending, and WCAG contrast.

/** An sRGB colour as 8-bit channels, the way the screen shows it. */
export type Rgb = readonly [red: number, green: number, blue: number];

const RAD = Math.PI / 180;

function oklabToLinearSrgb(l: number, a: number, b: number): [number, number, number] {
  const long = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const medium = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const short = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * long - 3.3077115913 * medium + 0.2309699292 * short,
    -1.2684380046 * long + 2.6097574011 * medium - 0.3413193965 * short,
    -0.0041960863 * long - 0.7034186147 * medium + 1.707614701 * short,
  ];
}

function toOklab([red, green, blue]: Rgb): [number, number, number] {
  const [r, g, b] = [red, green, blue].map((v) => decode(v / 255)) as [number, number, number];
  const long = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const medium = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const short = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * long + 0.793617785 * medium - 0.0040720468 * short,
    1.9779984951 * long - 2.428592205 * medium + 0.4505937099 * short,
    0.0259040371 * long + 0.7827717662 * medium - 0.808675766 * short,
  ];
}

const fitsSrgb = (linear: readonly number[]) => linear.every((v) => v >= -1e-4 && v <= 1 + 1e-4);
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function toRgb(linear: readonly number[]): Rgb {
  const [red, green, blue] = linear.map((v) => Math.round(encode(clamp(v, 0, 1)) * 255));
  return [red ?? 0, green ?? 0, blue ?? 0];
}

/**
 * An OKLCH colour in sRGB. When the colour is outside sRGB, its chroma is lowered until it fits,
 * so lightness and hue stay as asked.
 */
export function oklch(lightness: number, chroma: number, hue: number): Rgb {
  const l = clamp(lightness, 0, 1);
  const toLinear = (c: number) =>
    oklabToLinearSrgb(l, c * Math.cos(hue * RAD), c * Math.sin(hue * RAD));
  let linear = toLinear(chroma);
  if (!fitsSrgb(linear)) {
    let inside = 0;
    let outside = chroma;
    for (let i = 0; i < 20; i++) {
      const middle = (inside + outside) / 2;
      if (fitsSrgb(toLinear(middle))) inside = middle;
      else outside = middle;
    }
    linear = toLinear(inside);
  }
  return toRgb(linear);
}

/** The colour `amount` of the way from `from` to `to`, mixed in OKLab as CSS's `in oklab` does. */
export function mix(from: Rgb, to: Rgb, amount: number): Rgb {
  const start = toOklab(from);
  const end = toOklab(to);
  const [l, a, b] = start.map((v, i) => v + ((end[i] ?? v) - v) * amount);
  return toRgb(oklabToLinearSrgb(l ?? 0, a ?? 0, b ?? 0));
}

/** WCAG relative luminance, from 0 (black) to 1 (white). */
export function luminance([red, green, blue]: Rgb): number {
  return 0.2126 * decode(red / 255) + 0.7152 * decode(green / 255) + 0.0722 * decode(blue / 255);
}

/** WCAG contrast ratio, from 1 to 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** `top` drawn at `alpha` over `bottom`, the way the browser blends a translucent colour. */
export function blend(top: Rgb, alpha: number, bottom: Rgb): Rgb {
  const mix = (t: number, b: number) => Math.round(t * alpha + b * (1 - alpha));
  return [mix(top[0], bottom[0]), mix(top[1], bottom[1]), mix(top[2], bottom[2])];
}

export function toHex(color: Rgb): string {
  return `#${color.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}

/** A CSS colour, optionally translucent. */
export function toCss(color: Rgb, alpha = 1): string {
  return alpha === 1 ? toHex(color) : `rgb(${color.join(" ")} / ${alpha})`;
}
