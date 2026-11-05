/**
 * Track edges and kerbs rebuilt from telemetry (#36), on the 1 m distance grid. LMU track files are encrypted, so the
 * only source is what the car reports while driving: `track_edge` (distance to the edge on the side the car is on) and
 * `kerb` (a wheel is on a rumble strip).
 */
import type { XY } from "./geo";
import { LATERAL_LIMIT_M } from "./racingLine";

/** A `track_edge` sample is trusted only if its sign is the same for every index within ±FLIP_GUARD_M (metres). */
export const FLIP_GUARD_M = 6;
/** Measured half-widths are averaged over ±EDGE_SMOOTH_HALF_M (metres), using measured neighbours only. */
export const EDGE_SMOOTH_HALF_M = 3;
/** Kerb runs on the same side separated by a gap of at most KERB_MERGE_M (metres) are one run. */
export const KERB_MERGE_M = 5;
/** Kerb runs shorter than KERB_MIN_M (metres) are dropped as noise. */
export const KERB_MIN_M = 3;

/** One lap's channels on the 1 m grid (index = metres from the start line). */
export interface EdgeLap { pathLateral: ArrayLike<number>; trackEdge: ArrayLike<number>; kerb: ArrayLike<number> }

/**
 * Half-widths in metres (positive) from the centreline on each side, per grid metre; measured[i] = 1 where at least one
 * lap measured that side there, 0 where it was filled in.
 */
export interface TrackEdges { left: Float64Array; right: Float64Array; leftMeasured: Uint8Array; rightMeasured: Uint8Array }

/**
 * `track_edge` is sampled at 10 Hz and interpolated, so where the car crosses the centreline it sweeps through 0 between
 * a negative and a positive value. Those values are garbage; this marks the indices whose sign is steady (and non-zero)
 * over ±FLIP_GUARD_M, and which are on track.
 */
function validMask(lap: EdgeLap, m: number): Uint8Array {
  const ok = new Uint8Array(m);
  const sgn = new Int8Array(m);
  for (let i = 0; i < m; i++) {
    const e = lap.trackEdge[i], p = lap.pathLateral[i];
    sgn[i] = Number.isFinite(e) && Number.isFinite(p) && Math.abs(p) <= LATERAL_LIMIT_M ? Math.sign(e) : 0;
  }
  for (let i = 0; i < m; i++) {
    const s = sgn[i];
    if (s === 0) continue;
    let good = true;
    for (let j = Math.max(0, i - FLIP_GUARD_M); j <= Math.min(m - 1, i + FLIP_GUARD_M); j++) {
      if (sgn[j] !== s) { good = false; break; }
    }
    ok[i] = good ? 1 : 0;
  }
  return ok;
}

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Smooth measured values only (neighbours that were not measured do not count), closed loop. */
function smoothMeasured(v: Float64Array, measured: Uint8Array): Float64Array {
  const n = v.length;
  const out = new Float64Array(v);
  for (let i = 0; i < n; i++) {
    if (!measured[i]) continue;
    let s = 0, c = 0;
    for (let k = -EDGE_SMOOTH_HALF_M; k <= EDGE_SMOOTH_HALF_M; k++) {
      const j = (((i + k) % n) + n) % n;
      if (measured[j]) { s += v[j]; c++; }
    }
    out[i] = s / c;
  }
  return out;
}

/** Fill unmeasured stretches by linear interpolation between the nearest measured points, wrapping at the lap end. */
function fillGaps(v: Float64Array, measured: Uint8Array, fallback: number): void {
  const n = v.length;
  let any = -1;
  for (let i = 0; i < n; i++) if (measured[i]) { any = i; break; }
  if (any < 0) { v.fill(fallback); return; }
  // Walk the loop starting at a measured point so each gap is seen once, between its two measured ends.
  let prev = any;
  for (let step = 1; step <= n; step++) {
    const i = (any + step) % n;
    if (!measured[i]) continue;
    const gap = (i - prev + n) % n || n;
    for (let k = 1; k < gap; k++) {
      const t = k / gap;
      v[(prev + k) % n] = v[prev] * (1 - t) + v[i] * t;
    }
    prev = i;
  }
}

/**
 * Track half-widths on each side of the centreline. Left and right are measured and filled separately (they differ by
 * up to a few metres on Spa, so one side is never mirrored onto the other). Each side is only measured where a lap drove
 * on it, so gaps are interpolated; a side that was never measured gets `fallbackM`.
 */
export function edgeHalfWidths(laps: EdgeLap[], n: number, fallbackM = 7): TrackEdges {
  const leftS: number[][] = Array.from({ length: n }, () => []);
  const rightS: number[][] = Array.from({ length: n }, () => []);
  for (const lap of laps) {
    const m = Math.min(n, lap.pathLateral.length, lap.trackEdge.length);
    const ok = validMask(lap, m);
    for (let i = 0; i < m; i++) {
      if (!ok[i]) continue;
      (lap.trackEdge[i] < 0 ? leftS : rightS)[i].push(Math.abs(lap.trackEdge[i]));
    }
  }
  const build = (samples: number[][]): [Float64Array, Uint8Array] => {
    const v = new Float64Array(n);
    const measured = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (samples[i].length) { v[i] = median(samples[i]); measured[i] = 1; }
    const out = smoothMeasured(v, measured);
    fillGaps(out, measured, fallbackM);
    return [out, measured];
  };
  const [left, leftMeasured] = build(leftS);
  const [right, rightMeasured] = build(rightS);
  return { left, right, leftMeasured, rightMeasured };
}

/** A stretch of kerb on one side: inclusive grid metres, and how many distinct laps touched it. */
export interface KerbRun { side: "left" | "right"; start: number; end: number; laps: number }

/**
 * Kerb stretches from the `kerb` flag. The side is the sign of path_lateral (the kerb is on the side the car is on).
 * Runs do not wrap across the start/finish line. Several laps are merged so a kerb one lap missed is still found.
 */
export function kerbRuns(laps: EdgeLap[], n: number): KerbRun[] {
  const out: KerbRun[] = [];
  for (const side of ["left", "right"] as const) {
    const perLap = laps.map((lap) => {
      const m = Math.min(n, lap.pathLateral.length, lap.kerb.length);
      const hit = new Uint8Array(n);
      for (let i = 0; i < m; i++) {
        const p = lap.pathLateral[i];
        if (lap.kerb[i] === 1 && Math.abs(p) <= LATERAL_LIMIT_M && p !== 0 && (p < 0) === (side === "left")) hit[i] = 1;
      }
      return hit;
    });
    const marked = new Uint8Array(n);
    for (const h of perLap) for (let i = 0; i < n; i++) if (h[i]) marked[i] = 1;
    const runs: [number, number][] = [];
    for (let i = 0; i < n; i++) {
      if (!marked[i]) continue;
      const last = runs[runs.length - 1];
      if (last && i - last[1] - 1 <= KERB_MERGE_M) last[1] = i;
      else runs.push([i, i]);
    }
    for (const [start, end] of runs) {
      if (end - start + 1 < KERB_MIN_M) continue;
      let count = 0;
      for (const h of perLap) {
        for (let i = start; i <= end; i++) if (h[i]) { count++; break; }
      }
      out.push({ side, start, end, laps: count });
    }
  }
  return out.sort((a, b) => a.start - b.start || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
}

/** Edge polylines: left = centre + nLeft * left[i], right = centre - nLeft * right[i]. nLeft are unit left normals per point. */
export function edgeLines(centre: XY, nLeft: XY, e: TrackEdges): [XY, XY] {
  const n = centre.x.length;
  const l: XY = { x: new Float64Array(n), y: new Float64Array(n) };
  const r: XY = { x: new Float64Array(n), y: new Float64Array(n) };
  for (let i = 0; i < n; i++) {
    l.x[i] = centre.x[i] + nLeft.x[i] * e.left[i];
    l.y[i] = centre.y[i] + nLeft.y[i] * e.left[i];
    r.x[i] = centre.x[i] - nLeft.x[i] * e.right[i];
    r.y[i] = centre.y[i] - nLeft.y[i] * e.right[i];
  }
  return [l, r];
}
