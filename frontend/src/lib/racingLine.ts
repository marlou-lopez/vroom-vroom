import type { TrackMap } from "../api/types";
import type { XY } from "./geo";
import { smoothClosed } from "./trackmap";

/** Beyond this |path_lateral| (m) the car is off the track surface (pit lane, out-lap) and the value is meaningless. */
export const LATERAL_LIMIT_M = 15;
/**
 * Smoothing (half-widths in metres on the 1 m grid) for the lateral method. path_lateral is 10 Hz, so linear
 * interpolation onto the grid kinks every few metres; the centreline still carries GPS quantisation. Tuned on Spa
 * 2026-11-05: La Source wiggle 80 -> 22 mm (GPS +/-4: 28 mm), max gap to GPS +/-4 0.50 -> 0.32 m.
 */
export const LATERAL_SMOOTH_HALF = 4;
export const CENTRE_SMOOTH_HALF = 4;
/** Normals come from the chord i - 10 .. i + 10 m, so centreline noise barely turns them. */
export const NORMAL_HALF_M = 10;

/**
 * On track the lateral line agrees with the lap's own GPS (+/-4) to a few cm (worst 0.72 m on Spa flying laps). A larger
 * disagreement means path_lateral does not describe this lap (pit lane: it is measured from the pit path), so the
 * line blends from lateral to GPS between BLEND_FROM_M and BLEND_TO_M of disagreement.
 */
export const BLEND_FROM_M = 1;
export const BLEND_TO_M = 3;

const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Closed-loop moving average of the first n values over ±half, skipping samples with |v| > LATERAL_LIMIT_M (off track). */
function smoothLateral(v: ArrayLike<number>, n: number, half: number): Float64Array {
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -half; k <= half; k++) {
      const x = v[wrap(i + k, n)];
      if (Math.abs(x) <= LATERAL_LIMIT_M) { s += x; c++; }
    }
    out[i] = c > 0 ? s / c : v[i];
  }
  return out;
}

/** Unit left normals (x east, y north: tangent rotated +90 degrees) from the wrapped chord i - halfM .. i + halfM. */
export function normalsLeft(xy: XY, halfM = 1): XY {
  const n = Math.min(xy.x.length, xy.y.length);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = wrap(i - halfM, n), b = wrap(i + halfM, n);
    const tx = xy.x[b] - xy.x[a], ty = xy.y[b] - xy.y[a];
    const len = Math.hypot(tx, ty);
    if (len > 0) { x[i] = -ty / len; y[i] = tx / len; }
  }
  return { x, y };
}

/** Closed-loop smoothing of a GPS path (half 0 returns a copy). */
export function lineFromGps(xy: XY, half: number): XY {
  return { x: Float64Array.from(smoothClosed(xy.x, half)), y: Float64Array.from(smoothClosed(xy.y, half)) };
}

export interface LateralLap { xy: XY; pathLateral: ArrayLike<number> }

/** Track centreline implied by several laps: mean of p + pl * nLeft, refined from the normals of the previous guess. */
export function centreline(laps: LateralLap[], iterations = 2): XY {
  if (laps.length === 0) return { x: new Float64Array(0), y: new Float64Array(0) };
  const n = Math.min(...laps.map((l) => Math.min(l.xy.x.length, l.xy.y.length, l.pathLateral.length)));
  const mx = new Float64Array(n), my = new Float64Array(n);
  for (const l of laps) for (let i = 0; i < n; i++) { mx[i] += l.xy.x[i] / laps.length; my[i] += l.xy.y[i] / laps.length; }
  const pls = laps.map((l) => smoothLateral(l.pathLateral, n, LATERAL_SMOOTH_HALF));
  let c = lineFromGps({ x: mx, y: my }, 15);
  for (let it = 0; it < iterations; it++) {
    const nl = normalsLeft(c, NORMAL_HALF_M);
    const cx = new Float64Array(n), cy = new Float64Array(n);
    laps.forEach((l, k) => {
      const pl = pls[k];
      for (let i = 0; i < n; i++) {
        cx[i] += (l.xy.x[i] + pl[i] * nl.x[i]) / laps.length;
        cy[i] += (l.xy.y[i] + pl[i] * nl.y[i]) / laps.length;
      }
    });
    c = lineFromGps({ x: cx, y: cy }, CENTRE_SMOOTH_HALF);
  }
  return c;
}

/** Car line c - pl * nLeft (pl > 0 is right of travel; pl smoothed by LATERAL_SMOOTH_HALF). Where |pl| > 15 m, the fallback point is used; otherwise it blends toward the fallback as the two disagree by BLEND_FROM_M..BLEND_TO_M. */
export function lineFromLateral(centre: XY, pathLateral: ArrayLike<number>, fallback?: XY): XY {
  let n = Math.min(centre.x.length, pathLateral.length);
  if (fallback) n = Math.min(n, fallback.x.length, fallback.y.length);
  const nl = normalsLeft(centre, NORMAL_HALF_M);
  const smooth = smoothLateral(pathLateral, n, LATERAL_SMOOTH_HALF);
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const pl = smooth[i];
    const lx = centre.x[i] - pl * nl.x[i], ly = centre.y[i] - pl * nl.y[i];
    if (!fallback) { x[i] = lx; y[i] = ly; continue; }
    let w = 1;
    if (Math.abs(pathLateral[i]) <= LATERAL_LIMIT_M) {
      const d = Math.hypot(lx - fallback.x[i], ly - fallback.y[i]);
      w = Math.min(1, Math.max(0, (d - BLEND_FROM_M) / (BLEND_TO_M - BLEND_FROM_M)));
    }
    x[i] = lx * (1 - w) + fallback.x[i] * w;
    y[i] = ly * (1 - w) + fallback.y[i] * w;
  }
  return { x, y };
}

/** Euclidean distance between same-index points (length is the shorter path). */
export function pointDistances(a: XY, b: XY): Float64Array {
  const n = Math.min(a.x.length, b.x.length);
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = Math.hypot(a.x[i] - b.x[i], a.y[i] - b.y[i]);
  return d;
}

/** Mean, 95th percentile (sorted index ceil(0.95 n) - 1) and max of the values, optionally only where mask is true. */
export function distStats(v: ArrayLike<number>, mask?: ArrayLike<boolean>): { mean: number; p95: number; max: number; n: number } {
  const used: number[] = [];
  for (let i = 0; i < v.length; i++) if (!mask || mask[i]) used.push(v[i]);
  const n = used.length;
  if (n === 0) return { mean: 0, p95: 0, max: 0, n: 0 };
  used.sort((a, b) => a - b);
  let sum = 0;
  for (const x of used) sum += x;
  return { mean: sum / n, p95: used[Math.ceil(0.95 * n) - 1], max: used[n - 1], n };
}

/** True on grid indices at least `marginM` outside every corner (corners may wrap over the line), in runs of at least `minLenM`. */
export function straightMask(map: TrackMap, n: number, minLenM = 200, marginM = 50): boolean[] {
  const near = new Array<boolean>(n).fill(false);
  for (const c of map.corners) {
    const a = c.start_m - marginM;
    let b = c.end_m + marginM;
    if (c.start_m > c.end_m) b += n;
    if (b - a + 1 >= n) { near.fill(true); break; }
    for (let k = Math.round(a); k <= Math.round(b); k++) near[wrap(k, n)] = true;
  }
  const out = new Array<boolean>(n).fill(false);
  const first = near.indexOf(true);
  if (first < 0) { if (n >= minLenM) out.fill(true); return out; }
  // Walk the loop once from a non-candidate so runs crossing index n-1 -> 0 stay whole.
  let runStart = -1;
  for (let k = 1; k <= n + 1; k++) {
    const i = wrap(first + k, n);
    const cand = k <= n && !near[i];
    if (cand && runStart < 0) runStart = k;
    if (!cand && runStart >= 0) {
      if (k - runStart >= minLenM) for (let j = runStart; j < k; j++) out[wrap(first + j, n)] = true;
      runStart = -1;
    }
  }
  return out;
}

/** Signed distance of each line point from the centre along -nLeft (+ = right of travel), using the centre's normals. */
export function lateralOffsets(line: XY, centre: XY): Float64Array {
  const n = Math.min(line.x.length, centre.x.length);
  const nl = normalsLeft(centre, NORMAL_HALF_M);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = -((line.x[i] - centre.x[i]) * nl.x[i] + (line.y[i] - centre.y[i]) * nl.y[i]);
  return out;
}
