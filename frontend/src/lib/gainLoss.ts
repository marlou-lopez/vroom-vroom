/**
 * Where on the lap time is gained or lost (#59): the slope of the delta (s per metre), not the gap itself, so a corner
 * where you gain shows as gaining even while you are behind overall.
 */

/**
 * The slope is smoothed by GAIN_PASSES moving averages of ±GAIN_HALF_M (a bell-shaped kernel spanning about ±30 m).
 * One plain average is not enough: the delta moves in 1 ms steps, so a single box leaves the slope flickering every
 * few metres, which shows as stripes across a wide band (about 425 turning points per km on Spa; 3 x ±10 m: about 85).
 */
export const GAIN_HALF_M = 10;
export const GAIN_PASSES = 3;
/**
 * |rate| (s/m) below this is "about even". The issue suggested 0.002, but on Spa lap 4 vs 3 (0.44 s apart) only 2 % of
 * the lap is above that; 0.0002 colours about 35 % of it. To be tuned with #25.
 */
export const GAIN_NEUTRAL = 0.0002;
/** |rate| (s/m) at which the colour reaches full strength (about the 95th percentile on Spa lap 4 vs 3). */
export const GAIN_FULL = 0.0015;

/** Moving average over ±h, wrapping around (closed loop). */
function boxWrapped(v: Float64Array, h: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n);
  const w = 2 * h + 1;
  let sum = 0;
  for (let k = -h; k <= h; k++) sum += v[(k + n) % n];
  for (let i = 0; i < n; i++) {
    out[i] = sum / w;
    sum += v[(i + h + 1) % n] - v[(i - h + n) % n];
  }
  return out;
}

/**
 * Smoothed slope of `delta` (s, positive = behind) on the 1 m grid: per-metre steps smoothed by `passes` moving
 * averages of ±halfM, wrapping around start/finish. The step from the last point back to the first is not a real step
 * (the delta resets to 0 at the line), so it is replaced by the mean of its two neighbours. Positive = losing time.
 */
export function gainRate(delta: ArrayLike<number>, halfM = GAIN_HALF_M, passes = GAIN_PASSES): Float64Array {
  const n = delta.length;
  if (n < 3) return new Float64Array(n);
  // step[i] = change from point i to point i + 1; step[n - 1] is the wrap.
  let step: Float64Array = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) step[i] = delta[i + 1] - delta[i];
  step[n - 1] = (step[n - 2] + step[0]) / 2;
  const h = Math.min(halfM, Math.floor((n - 1) / 2));
  for (let p = 0; p < passes; p++) step = boxWrapped(step, h);
  return step;
}

/** Signed colour strength in [-1, 1]: 0 inside the neutral band, ±1 at or beyond `full`; positive = losing. */
export function gainStrength(rate: number, neutral = GAIN_NEUTRAL, full = GAIN_FULL): number {
  const m = Math.abs(rate);
  if (!(m > neutral)) return 0;
  const t = Math.min(1, (m - neutral) / (full - neutral));
  return rate > 0 ? t : -t;
}
