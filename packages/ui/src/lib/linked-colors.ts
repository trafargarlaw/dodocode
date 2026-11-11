import { MAX_COLORS, type WallpaperColor } from "@dodocode/ui/lib/theme";

// The wallpaper's colours move together. The first colour leads: moving it carries the others,
// so a palette keeps its shape while it turns round the wheel or fades. Any other colour moves
// alone, to change the shape.

const wrapHue = (hue: number) => ((hue % 360) + 360) % 360;
const clampStrength = (strength: number) => Math.min(1, Math.max(0, strength));

/**
 * The colours after colour `index` moves to `to`. Pass the colours as they were when the drag
 * started, so a colour pushed against full strength comes back when the lead does.
 */
export function moveColor(
  start: readonly WallpaperColor[],
  index: number,
  to: WallpaperColor,
): WallpaperColor[] {
  const target = { hue: wrapHue(to.hue), strength: clampStrength(to.strength) };
  const lead = start[0];
  if (index !== 0 || !lead) return start.map((color, i) => (i === index ? target : color));

  return start.map((color, i) => {
    if (i === 0) return target;
    // Each colour keeps its hue gap to the lead and its share of the lead's strength. A lead at
    // the centre has no strength to share, so the others come out with it.
    const share = lead.strength > 0.001 ? color.strength / lead.strength : 1;
    return {
      hue: wrapHue(color.hue + target.hue - lead.hue),
      strength: clampStrength(share * target.strength),
    };
  });
}

/** Adds a colour a third of the way round the wheel from the last, as strong as the lead. */
export function addColor(colors: readonly WallpaperColor[]): readonly WallpaperColor[] {
  const lead = colors[0];
  const last = colors.at(-1);
  if (!lead || !last || colors.length >= MAX_COLORS) return colors;
  return [...colors, { hue: wrapHue(last.hue + 120), strength: lead.strength }];
}

/** Removes the last colour, but never the only one. */
export function removeColor(colors: readonly WallpaperColor[]): readonly WallpaperColor[] {
  return colors.length > 1 ? colors.slice(0, -1) : colors;
}
