// Pure helpers for the extractor, kept apart so the frontend's tests can import them (the extractor itself needs a recording).

/** rF2 surface types for a wheel off the track: 2 grass, 4 gravel (inferred; kerbs 5 and 6 and tarmac 0 count as on track). */
export const OFF_TRACK_SURFACES = new Set([2, 4]);

/** Number of wheels (0..4) on grass or gravel in one SurfaceTypes sample (four wheel values). */
export const countOffTrack = (wheels) => Array.from(wheels).filter((w) => OFF_TRACK_SURFACES.has(Number(w))).length;

/**
 * Stepwise (sample-and-hold) lookup: the value of the latest sample at or before x, never an interpolation.
 * xs ascending; before the first sample it is the first value.
 */
export function step(xs, ys, x) {
  if (x < xs[0]) return ys[0];
  let lo = 0, hi = xs.length - 1;
  if (xs[hi] <= x) return ys[hi];
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (xs[m] <= x) lo = m; else hi = m; }
  return ys[lo];
}
