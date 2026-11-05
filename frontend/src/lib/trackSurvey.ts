// Track edges and kerbs from a shared-memory survey of the track (#97), on a lap's 1 m grid.
//
// A survey (tools/lmu-logger/decode.py survey) is a list of world-space samples: LMU's edge distance on the car's side
// (`mTrackEdge`, a half-width from LMU's centre path) from every car on track, and the wheels' kerb hits. Both are
// matched to a lap's grid by position, like the elevation capture: lat/lon -> world x/z, nearest point of the lap.
import type { SurveyKerb, TrackSurvey } from "../api/types";
import { latLonToWorld, worldToLatLon } from "./elevation";
import type { XY } from "./geo";
import { KERB_MERGE_M, KERB_MIN_M } from "./trackEdges";

export type SurveyKerbKind = SurveyKerb["kind"];

/** The shape of public/mock/<track>-survey-*.json (written by decode.py survey). side: 0 = left, 1 = right. */
export interface SurveyFile {
  source: string;
  track: string | null;
  captures: string[];
  edges: [x: number, z: number, side: 0 | 1, half_m: number][];
  kerbs: [x: number, z: number, side: 0 | 1, kind: SurveyKerbKind][];
  /** Wheel crossings (world x/z, 0.25 m apart at most): "edge" = tarmac <-> anything else, "kerb_outer" = kerb <-> ground beside it. */
  contacts?: [x: number, z: number, kind: "edge" | "kerb_outer"][];
  /** The wheel offsets the contacts were placed with, for the record. */
  wheel_offsets?: Record<string, unknown>;
}

/** Survey samples further than this (m) from the lap's path are not on that road (pit lane, run-off) and are dropped. */
export const SURVEY_MATCH_M = 15;
/**
 * Scoring updates at 5 Hz, so cars sample the edge every 5.6 m at the survey's 100 km/h (more at speed): per grid metre
 * most indices have no sample. Gaps of at most this many metres between measured indices are interpolated and count as
 * measured; longer ones stay null.
 */
export const SURVEY_GAP_M = 8;
const CELL_M = 15;
const cellKey = (cx: number, cz: number) => cx * 100003 + cz;

function median(v: number[]): number {
  const s = v.slice().sort((a, b) => a - b);
  const h = s.length >> 1;
  return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
}

/** Maps world x/z to the nearest grid index of one lap's polyline (null beyond `maxM`). */
function polylineMatcher(lat: ArrayLike<number>, lon: ArrayLike<number>, maxM: number) {
  const n = lat.length;
  const px = new Float64Array(n), pz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const w = latLonToWorld(lat[i], lon[i]);
    px[i] = w.x; pz[i] = w.z;
  }
  // Segment i joins point i and i + 1; it is listed in every cell its endpoints fall in (1 m segments).
  const cells = new Map<number, number[]>();
  for (let i = 0; i + 1 < n; i++) {
    let last = NaN;
    for (const j of [i, i + 1]) {
      const key = cellKey(Math.floor(px[j] / CELL_M), Math.floor(pz[j] / CELL_M));
      if (key === last) continue;
      last = key;
      const list = cells.get(key);
      if (list) list.push(i); else cells.set(key, [i]);
    }
  }
  const reach = Math.ceil(maxM / CELL_M);
  return (x: number, z: number): number | null => {
    const cx = Math.floor(x / CELL_M), cz = Math.floor(z / CELL_M);
    let best = Infinity, bestIdx = -1;
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dz = -reach; dz <= reach; dz++) {
        const list = cells.get(cellKey(cx + dx, cz + dz));
        if (!list) continue;
        for (const i of list) {
          const vx = px[i + 1] - px[i], vz = pz[i + 1] - pz[i];
          const len2 = vx * vx + vz * vz;
          const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - px[i]) * vx + (z - pz[i]) * vz) / len2)) : 0;
          const d = Math.hypot(x - (px[i] + u * vx), z - (pz[i] + u * vz));
          if (d < best) { best = d; bestIdx = u >= 0.5 ? i + 1 : i; }
        }
      }
    }
    return best <= maxM ? bestIdx : null;
  };
}

/** Most common kind; ties go to flat, then razor (the kinds that are certainly kerbs). */
function commonKind(counts: Record<SurveyKerbKind, number>): SurveyKerbKind {
  let best: SurveyKerbKind = "flat";
  for (const k of ["razor", "other"] as const) if (counts[k] > counts[best]) best = k;
  return best;
}

/**
 * The survey on a lap's grid: per index and side the median LMU half-width of the edge samples nearest to it (gaps up to SURVEY_GAP_M
 * interpolated, null where longer), the wheel-contact points near the lap (as lat/lon, unsided), and kerb runs. Kerb hits are flagged per index and side; runs on one side separated by at most KERB_MERGE_M
 * are one run, runs shorter than KERB_MIN_M are dropped, and a run's kind is its most common one. Runs do not wrap
 * across the start/finish line (same as kerbRuns).
 */
export function mapSurvey(
  survey: Pick<SurveyFile, "edges" | "kerbs"> & Partial<Pick<SurveyFile, "contacts">>, lat: ArrayLike<number>, lon: ArrayLike<number>, maxM = SURVEY_MATCH_M,
): TrackSurvey {
  const n = Math.min(lat.length, lon.length);
  const match = polylineMatcher(lat, lon, maxM);
  const samples: [number[][], number[][]] = [Array.from({ length: n }, () => []), Array.from({ length: n }, () => [])];
  for (const [x, z, side, half] of survey.edges) {
    const i = match(x, z);
    if (i !== null && i < n) samples[side][i].push(half);
  }
  const edge = (side: 0 | 1) => {
    const v = samples[side].map((s) => (s.length ? median(s) : null));
    let prev = -1;
    for (let i = 0; i < n; i++) {
      if (v[i] === null) continue;
      if (prev >= 0 && i - prev > 1 && i - prev <= SURVEY_GAP_M) {
        for (let k = prev + 1; k < i; k++) v[k] = v[prev]! + ((v[i]! - v[prev]!) * (k - prev)) / (i - prev);
      }
      prev = i;
    }
    return v.map((x) => (x === null ? null : Math.round(x * 100) / 100));
  };

  const kerbs: SurveyKerb[] = [];
  const hits: [Map<number, Record<SurveyKerbKind, number>>, Map<number, Record<SurveyKerbKind, number>>] = [new Map(), new Map()];
  for (const [x, z, side, kind] of survey.kerbs) {
    const i = match(x, z);
    if (i === null || i >= n) continue;
    const c = hits[side].get(i) ?? { flat: 0, razor: 0, other: 0 };
    c[kind]++;
    hits[side].set(i, c);
  }
  for (const side of [0, 1] as const) {
    const idx = [...hits[side].keys()].sort((a, b) => a - b);
    const runs: number[][] = [];
    for (const i of idx) {
      const last = runs[runs.length - 1];
      if (last && i - last[last.length - 1] - 1 <= KERB_MERGE_M) last.push(i);
      else runs.push([i]);
    }
    for (const run of runs) {
      const start = run[0], end = run[run.length - 1];
      if (end - start + 1 < KERB_MIN_M) continue;
      const total: Record<SurveyKerbKind, number> = { flat: 0, razor: 0, other: 0 };
      for (const i of run) {
        const k = commonKind(hits[side].get(i)!);
        total[k]++;
      }
      kerbs.push({ side: side === 0 ? "left" : "right", start_m: start, end_m: end, kind: commonKind(total), width_m: null });
    }
  }
  kerbs.sort((a, b) => a.start_m - b.start_m || (a.side < b.side ? -1 : a.side > b.side ? 1 : 0));
  const edge_points: [number, number][] = [], kerb_outer_points: [number, number][] = [];
  for (const [x, z, kind] of survey.contacts ?? []) {
    if (match(x, z) === null) continue;
    const { lat: la, lon: lo } = worldToLatLon(x, z);
    (kind === "edge" ? edge_points : kerb_outer_points).push([Math.round(la * 1e7) / 1e7, Math.round(lo * 1e7) / 1e7]);
  }
  return { left_m: edge(0), right_m: edge(1), kerbs, edge_points, kerb_outer_points };
}

// ---------------------------------------------------------------- the scene's side: contacts to half-widths

/** Contact points are matched to the scene's centreline when they are within this many metres of it. */
export const CONTACT_MATCH_M = 20;
/** Contact half-widths outside this range (m) are not an edge of this road (pit lane, another track section). */
export const CONTACT_HALF_RANGE_M: [number, number] = [1.5, 20];
/** A grid index takes the contacts of this many neighbouring indices (m) on each side too. */
export const CONTACT_POOL_M = 1;
/** Measured contact half-widths are averaged over +/- this many metres (measured neighbours only). */
export const CONTACT_SMOOTH_HALF_M = 2;
/** LMU's half-width, jumpy because it follows the AI path's waypoints, is averaged over +/- this many metres where it is the fallback. */
export const LMU_SMOOTH_HALF_M = 15;
/** The shift that carries the fallback to a measured end is the median difference over the nearest this many metres of contacts. */
export const CORRECTION_SPAN_M = 10;
/**
 * Two measured indices on one side at most this many metres apart are joined by a straight line between their contact
 * half-widths, and LMU is ignored in between ("bridged"). Longer gaps keep the LMU fallback with offset correction.
 */
export const CONTACT_BRIDGE_M = 30;
/** A contact is dropped when its half-width differs by more than this (m) from the median of its side's contacts within +/- CONTACT_OUTLIER_SPAN_M. */
export const CONTACT_OUTLIER_M = 0.75;
export const CONTACT_OUTLIER_SPAN_M = 10;
/** A kerb's measured width (m) is believed only within this range, from at least KERB_WIDTH_MIN_POINTS outer points. */
export const KERB_WIDTH_RANGE_M: [number, number] = [0.3, 3];
export const KERB_WIDTH_MIN_POINTS = 3;

/** Where a point lies against a centreline: nearest grid index and signed lateral offset (+ = left of travel). */
export interface Projected { index: number; offset: number }

/**
 * Projects points onto a centreline (nearest segment, within `maxM`), like polylineMatcher does for the survey but in local
 * metres and with the signed offset along the segment's left normal (-ty, tx), the same side as `normalsLeft`. The last
 * point joins the first when they are within 5 m (a closed lap).
 */
export function centreProjector(centre: XY, maxM = CONTACT_MATCH_M): (x: number, y: number) => Projected | null {
  const n = Math.min(centre.x.length, centre.y.length);
  const cx = centre.x, cy = centre.y;
  const segs = n - 1 + (n > 2 && Math.hypot(cx[0] - cx[n - 1], cy[0] - cy[n - 1]) < 5 ? 1 : 0);
  const cells = new Map<number, number[]>();
  const add = (x: number, y: number, i: number) => {
    const key = cellKey(Math.floor(x / CELL_M), Math.floor(y / CELL_M));
    const list = cells.get(key);
    if (!list) cells.set(key, [i]);
    else if (list[list.length - 1] !== i) list.push(i);
  };
  for (let i = 0; i < segs; i++) {
    const j = (i + 1) % n;
    add(cx[i], cy[i], i);
    add(cx[j], cy[j], i);
  }
  const reach = Math.ceil(maxM / CELL_M);
  return (x, y) => {
    const gx = Math.floor(x / CELL_M), gy = Math.floor(y / CELL_M);
    let best = Infinity, bi = -1, bu = 0, bs = 0;
    for (let dx = -reach; dx <= reach; dx++) {
      for (let dy = -reach; dy <= reach; dy++) {
        const list = cells.get(cellKey(gx + dx, gy + dy));
        if (!list) continue;
        for (const i of list) {
          const j = (i + 1) % n;
          const vx = cx[j] - cx[i], vy = cy[j] - cy[i];
          const len2 = vx * vx + vy * vy;
          if (len2 === 0) continue;
          const u = Math.min(1, Math.max(0, ((x - cx[i]) * vx + (y - cy[i]) * vy) / len2));
          const px = cx[i] + u * vx, py = cy[i] + u * vy;
          const d = Math.hypot(x - px, y - py);
          if (d < best) {
            best = d; bi = i; bu = u;
            bs = ((x - px) * -vy + (y - py) * vx) / Math.sqrt(len2);
          }
        }
      }
    }
    if (best > maxM) return null;
    return { index: bu >= 0.5 ? (bi + 1) % n : bi, offset: bs };
  };
}

const wrap = (i: number, n: number) => ((i % n) + n) % n;

/** Moving average of `v` over +/- half indices (closed loop), counting only entries where `ok` is set; NaN where none counts. */
function movingAverage(v: ArrayLike<number>, ok: ArrayLike<number>, half: number): Float64Array {
  const n = v.length;
  const out = new Float64Array(n).fill(NaN);
  const h = Math.min(half, Math.floor((n - 1) / 2));
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -h; k <= h; k++) {
      const j = wrap(i + k, n);
      if (ok[j]) { s += v[j]; c++; }
    }
    if (c) out[i] = s / c;
  }
  return out;
}

/** Linear interpolation across NaN runs (closed loop); all NaN becomes `fallback`. */
function interpolateNaN(v: Float64Array, fallback: number): void {
  const n = v.length;
  const first = v.findIndex((x) => !Number.isNaN(x));
  if (first < 0) { v.fill(fallback); return; }
  let prev = first;
  for (let step = 1; step <= n; step++) {
    const i = (first + step) % n;
    if (Number.isNaN(v[i])) continue;
    const gap = (i - prev + n) % n || n;
    for (let k = 1; k < gap; k++) v[(prev + k) % n] = v[prev] + ((v[i] - v[prev]) * k) / gap;
    prev = i;
  }
}

/** LMU's half-widths averaged over +/- LMU_SMOOTH_HALF_M (closed loop, null entries skipped), gaps interpolated, `fallbackM` if it has none at all. */
export function smoothLmu(lmu: ArrayLike<number | null>, n: number, fallbackM = 7): Float64Array {
  const v = new Float64Array(n), ok = new Uint8Array(n);
  for (let i = 0; i < Math.min(n, lmu.length); i++) {
    const x = lmu[i];
    if (x !== null && Number.isFinite(x) && x > 0) { v[i] = x; ok[i] = 1; }
  }
  const s = movingAverage(v, ok, LMU_SMOOTH_HALF_M);
  interpolateNaN(s, fallbackM);
  return s;
}

export interface SurveyHalfWidths {
  left: Float64Array; right: Float64Array;
  /** 1 where a contact is within CONTACT_POOL_M: a real measurement. */
  leftMeasured: Uint8Array; rightMeasured: Uint8Array;
  /** 1 where the value is interpolated between two contacts at most CONTACT_BRIDGE_M apart: not measured, but LMU is ignored. */
  leftBridged: Uint8Array; rightBridged: Uint8Array;
  /** Contacts rejected as outliers, per side [left, right]. */
  dropped: [number, number];
}

/**
 * Drops contacts whose half-width is more than CONTACT_OUTLIER_M from the median of the side's contacts within
 * +/- CONTACT_OUTLIER_SPAN_M indices (closed loop, itself included). A window with fewer than 3 contacts is not judged.
 */
function rejectOutliers(samples: number[][], n: number): { kept: number[][]; dropped: number } {
  const kept: number[][] = Array.from({ length: n }, () => []);
  let dropped = 0;
  for (let i = 0; i < n; i++) {
    if (!samples[i].length) continue;
    const w: number[] = [];
    for (let k = -CONTACT_OUTLIER_SPAN_M; k <= CONTACT_OUTLIER_SPAN_M; k++) w.push(...samples[wrap(i + k, n)]);
    const med = median(w);
    for (const h of samples[i]) {
      if (w.length >= 3 && Math.abs(h - med) > CONTACT_OUTLIER_M) dropped++;
      else kept[i].push(h);
    }
  }
  return { kept, dropped };
}

/**
 * Half-widths (m from the centreline) per grid metre and side from the edge-contact points (local metres) and LMU's widths.
 *
 * Each contact is projected onto the centreline: its side is the sign of the offset and its half-width the offset's size, so
 * the drawn edge passes through the measured points even where the rebuilt centreline is off. An index takes the median of
 * the contacts within CONTACT_POOL_M of it and is "measured" if there is one; measured values are lightly smoothed
 * (CONTACT_SMOOTH_HALF_M). Outlier contacts are dropped first (rejectOutliers). Between two measured indices at most
 * CONTACT_BRIDGE_M apart (closed loop, so across the start/finish line too) the half-width is a straight line between the
 * smoothed contact values and the metres count as "bridged", not measured. Elsewhere the half-width is LMU's, averaged over LMU_SMOOTH_HALF_M (its values jump by metres between
 * waypoints) and shifted by an offset that moves linearly across the gap from the correction at one measured end to the
 * other's (a correction is the median of contact minus smoothed LMU over the nearest CORRECTION_SPAN_M of measured indices
 * at that end). A side without any contact keeps smoothed LMU as it is, and `fallbackM` where LMU has nothing either.
 */
export function surveyHalfWidths(
  project: (x: number, y: number) => Projected | null, edgePoints: XY, lmuLeft: ArrayLike<number | null>, lmuRight: ArrayLike<number | null>,
  n: number, fallbackM = 7,
): SurveyHalfWidths {
  const raw: [number[][], number[][]] = [Array.from({ length: n }, () => []), Array.from({ length: n }, () => [])];
  for (let k = 0; k < edgePoints.x.length; k++) {
    const p = project(edgePoints.x[k], edgePoints.y[k]);
    if (!p || p.index >= n) continue;
    const half = Math.abs(p.offset);
    if (half < CONTACT_HALF_RANGE_M[0] || half > CONTACT_HALF_RANGE_M[1]) continue;
    raw[p.offset > 0 ? 0 : 1][p.index].push(half);
  }
  const side = (all: number[][], lmu: ArrayLike<number | null>): [Float64Array, Uint8Array, Uint8Array, number] => {
    const { kept: samples, dropped } = rejectOutliers(all, n);
    const bridged = new Uint8Array(n);
    // contact half-widths, pooled over neighbouring indices
    const c = new Float64Array(n), measured = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const pool: number[] = [];
      for (let k = -CONTACT_POOL_M; k <= CONTACT_POOL_M; k++) pool.push(...samples[wrap(i + k, n)]);
      if (pool.length) { c[i] = median(pool); measured[i] = 1; }
    }
    const s = smoothLmu(lmu, n, fallbackM);
    const out = Float64Array.from(s);
    const idx: number[] = [];
    for (let i = 0; i < n; i++) if (measured[i]) idx.push(i);
    if (idx.length === 0) return [out, measured, bridged, dropped];
    const cs = movingAverage(c, measured, CONTACT_SMOOTH_HALF_M);
    // Corrections at the two ends of every gap, walking the loop from a measured index.
    const corr = new Float64Array(n);
    const endCorrection = (from: number, dir: 1 | -1): number => {
      const d: number[] = [];
      for (let k = 0; k < CORRECTION_SPAN_M; k++) {
        const j = wrap(from + dir * k, n);
        if (measured[j]) d.push(c[j] - s[j]);
      }
      return median(d);
    };
    const first = idx[0];
    let prev = first;
    for (let step = 1; step <= n; step++) {
      const i = (first + step) % n;
      if (!measured[i]) continue;
      const gap = (i - prev + n) % n || n;
      if (gap > 1 && gap <= CONTACT_BRIDGE_M) {
        for (let k = 1; k < gap; k++) {
          const j = (prev + k) % n;
          out[j] = cs[prev] + ((cs[i] - cs[prev]) * k) / gap;
          bridged[j] = 1;
        }
      } else if (gap > 1) {
        const a = endCorrection(prev, -1), b = endCorrection(i, 1);
        for (let k = 1; k < gap; k++) corr[(prev + k) % n] = a + ((b - a) * k) / gap;
      }
      prev = i;
    }
    for (let i = 0; i < n; i++) out[i] = Math.max(measured[i] ? cs[i] : bridged[i] ? out[i] : s[i] + corr[i], 1);
    return [out, measured, bridged, dropped];
  };
  const [left, leftMeasured, leftBridged, dl] = side(raw[0], lmuLeft);
  const [right, rightMeasured, rightBridged, dr] = side(raw[1], lmuRight);
  return { left, right, leftMeasured, rightMeasured, leftBridged, rightBridged, dropped: [dl, dr] };
}

/**
 * A kerb run's width: the median, over the kerb-outer points that project into the run on its side, of their distance from the
 * centreline minus the edge's half-width there. null when fewer than KERB_WIDTH_MIN_POINTS points, or the result is outside
 * KERB_WIDTH_RANGE_M.
 */
export function kerbWidth(
  project: (x: number, y: number) => Projected | null, outerPoints: XY, side: "left" | "right", start: number, end: number,
  halfWidth: ArrayLike<number>,
): number | null {
  const d: number[] = [];
  for (let k = 0; k < outerPoints.x.length; k++) {
    const p = project(outerPoints.x[k], outerPoints.y[k]);
    if (!p || p.index < start || p.index > end || (p.offset > 0) !== (side === "left")) continue;
    d.push(Math.abs(p.offset) - halfWidth[p.index]);
  }
  if (d.length < KERB_WIDTH_MIN_POINTS) return null;
  const w = median(d);
  return w >= KERB_WIDTH_RANGE_M[0] && w <= KERB_WIDTH_RANGE_M[1] ? Math.round(w * 100) / 100 : null;
}
