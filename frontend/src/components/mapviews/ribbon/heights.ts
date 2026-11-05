/** Half-width (grid points = metres) of the moving average that takes the noise off the road heights. */
export const SMOOTH_HALF_M = 2;

/**
 * Road height per centreline grid index from the contract's elevation (#94): the mean of the lap's and the reference
 * lap's heights where present (each is the car's reference point height, which is treated as the road height),
 * gaps filled by linear interpolation (the ends hold the nearest height), then a light moving average.
 * null when there is no elevation at all (a track without a capture, or every entry null).
 */
export function roadHeights(elevation: { lap: (number | null)[]; ref: (number | null)[] } | null | undefined, n: number): Float64Array | null {
  if (!elevation || n <= 0) return null;
  const raw = new Float64Array(n).fill(NaN);
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const a = elevation.lap[i], b = elevation.ref[i];
    const aOk = typeof a === "number" && Number.isFinite(a), bOk = typeof b === "number" && Number.isFinite(b);
    if (aOk && bOk) raw[i] = (a + b) / 2;
    else if (aOk) raw[i] = a;
    else if (bOk) raw[i] = b;
    if (!Number.isNaN(raw[i])) valid++;
  }
  if (valid === 0) return null;
  fillGaps(raw);
  return smooth(raw, SMOOTH_HALF_M);
}

function fillGaps(h: Float64Array): void {
  const n = h.length;
  let prev = -1;
  for (let i = 0; i < n; i++) {
    if (Number.isNaN(h[i])) continue;
    if (prev < 0) {
      for (let k = 0; k < i; k++) h[k] = h[i];
    } else if (i - prev > 1) {
      for (let k = prev + 1; k < i; k++) h[k] = h[prev] + ((h[i] - h[prev]) * (k - prev)) / (i - prev);
    }
    prev = i;
  }
  for (let k = prev + 1; k < n; k++) h[k] = h[prev];
}

/** Moving average of half-width `half`; the window shrinks at the ends (no wrap, the lap is not guaranteed closed). */
function smooth(h: Float64Array, half: number): Float64Array {
  const n = h.length;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    let s = 0;
    for (let k = lo; k <= hi; k++) s += h[k];
    out[i] = s / (hi - lo + 1);
  }
  return out;
}

/** Height at fractional grid index d (linear, clamped to the ends). */
export function heightAt(h: Float64Array, d: number): number {
  const n = h.length;
  if (n === 0) return 0;
  const f = Math.min(Math.max(d, 0), n - 1);
  const i = Math.min(Math.floor(f), n - 1), j = Math.min(i + 1, n - 1);
  return h[i] + (h[j] - h[i]) * (f - i);
}
