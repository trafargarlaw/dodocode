// Numbers the thread shows: what a turn cost, and how many tokens it took.

/** Dollars, to the cent, or below a cent to a tenth of one. */
export function cost(usd: number): string {
  // Rounded first, so a cost just short of a cent reads `$0.01`, not `$0.010`.
  const tenths = Math.round(usd * 1000);
  if (tenths >= 10) return `$${usd.toFixed(2)}`;
  // A cached turn can cost less than a tenth of a cent, which `$0.000` would read as free.
  if (tenths === 0 && usd > 0) return "<$0.001";
  return `$${(tenths / 1000).toFixed(3)}`;
}

/** A count as people read it at a glance: `950`, `12.3k`, `1.2M`. */
export function compact(count: number): string {
  if (count < 1000) return String(count);
  // Rounded first, so a count just short of a million reads `1M`, not `1000k`.
  const thousands = shown(count / 1000);
  if (thousands < 1000) return `${thousands}k`;
  return `${shown(count / 1_000_000)}M`;
}

/** Three figures at most: a tenth below 100, whole from there. */
function shown(value: number): number {
  return value >= 100 ? Math.round(value) : Math.round(value * 10) / 10;
}
