/**
 * Automatic colour assignment. Nobody picks colours in the panel: a new app,
 * teammate or meeting series gets the palette colour that is used least by
 * its siblings, so tiles and dots stay visibly different from each other for
 * as long as the palette allows, and only then start to repeat.
 */
export function pickDistinctColor(used: (string | null | undefined)[], palette: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const c of used) if (c) counts.set(c.toLowerCase(), (counts.get(c.toLowerCase()) ?? 0) + 1);
  let best = palette[0];
  let bestCount = Number.POSITIVE_INFINITY;
  for (const c of palette) {
    const n = counts.get(c.toLowerCase()) ?? 0;
    if (n < bestCount) {
      best = c;
      bestCount = n;
      if (n === 0) break; // first unused wins, keeping palette order
    }
  }
  return best;
}

/** Meeting-series dots: ink first, then clearly separated hues. */
export const SERIES_COLORS = ["#1c1c1a", "#2563eb", "#059669", "#d97706", "#dc2626", "#7c3aed", "#0d9488", "#db2777", "#ea580c", "#4f46e5"] as const;
