import type { CompareResponse } from "../../../api/types";
import { bounds, headingAt, originOf, pointAt, toLocalMetres, type Pt, type XY } from "../../../lib/geo";
import { distanceAtTime } from "../../../lib/playback";
import { KERB_W_M } from "./renderer";
import { gainRate } from "../../../lib/gainLoss";
import { edgeHalfWidths, edgeLines, kerbRuns, type EdgeLap } from "../../../lib/trackEdges";
import { LATERAL_LIMIT_M, NORMAL_HALF_M, centreline, lateralOffsets, lineFromGps, lineFromLateral, normalsLeft } from "../../../lib/racingLine";

/**
 * The gain/loss line (#59), left of travel. Its points are centre + normal * (clearM + a screen-px gap converted at
 * the current zoom), so the renderer rebuilds them only when the zoom changes. rate is s/m, positive = losing.
 */
export interface GainLine { normals: XY; clearM: Float64Array; rate: Float64Array }

/** A kerb stretch (#36): a polyline along one side of the track, its centre KERB_OFFSET_M (half the kerb width) outside that side's edge so the inner side lies on the edge line. */
export interface Kerb { side: "left" | "right"; xy: XY; laps: number }

/** Everything a renderer draws, in local metres (x east, y north). */
/**
 * surface: left and right borders of the track-surface gain/loss band, which always holds both car lines (#59). With telemetry edges the borders are the measured edges, widened only where a car line leaves them.
 * edgeMeasured: left and right, 1 where telemetry measured that edge (null for the stand-in edges); kerbs: empty for the stand-in.
 */
export interface Scene {
  lap: XY; ref: XY; centre: XY; edges: [XY, XY]; edgeMeasured: [Uint8Array, Uint8Array] | null; kerbs: Kerb[];
  gain: GainLine; surface: [XY, XY]; bounds: ReturnType<typeof bounds>;
}

export type LineSource = "gps" | "lateral";
export type CarSync = "time" | "distance";
/** "stand-in": the centreline +/- 7 m; "telemetry": edges and kerbs rebuilt from the laps' track_edge and kerb channels (#36, experimental). */
export type EdgeSource = "stand-in" | "telemetry";
export interface SceneOptions { source: LineSource; gpsHalf: number; edges?: EdgeSource }

/**
 * Kerbs are centred this far (m) outside the track edge: half the kerb width, so the kerb's inner side lies on the edge line.
 * Why outside: measured on Spa laps 1-4, with the kerb flag on the car centre is a median 0.44 m inside the reported edge (p5 -0.56, p95 1.81), so with the outer wheels ~0.8 m from the centre they are usually 0-1.4 m past it. LMU's track_edge appears to mark the inner line of the kerbs, and kerbs lie mostly outside it. Width is a guess.
 */
export const KERB_OFFSET_M = KERB_W_M / 2;

/** Half the stand-in track width in metres. */
const EDGE_OFFSET_M = 7;

/** Line offset by `offset` metres along the left normal (-ty, tx); tangent from the wrapped central difference. */
function offsetLine(xy: XY, offset: number): XY {
  const n = xy.x.length;
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = (i - 1 + n) % n, b = (i + 1) % n;
    const tx = xy.x[b] - xy.x[a], ty = xy.y[b] - xy.y[a];
    const len = Math.hypot(tx, ty) || 1;
    x[i] = xy.x[i] - (ty / len) * offset;
    y[i] = xy.y[i] + (tx / len) * offset;
  }
  return { x, y };
}

/** Half-width (m) of the window max and of the moving average that turn the per-point clearance into a smooth one. */
const GAIN_CLEAR_HALF_M = 20;

/** Margin (m) the track-surface band keeps beyond the outermost car line, so no sliver of it runs beside a line. */
export const SURFACE_MARGIN_M = 2;

/** Window max then moving average (both wrapped, half-width `half` points) of `raw`; never below `raw` at any point. */
function smoothClearance(raw: Float64Array, half: number): Float64Array {
  const n = raw.length;
  const h = Math.min(half, Math.floor((n - 1) / 2));
  const wmax = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let m = -Infinity;
    for (let k = -h; k <= h; k++) m = Math.max(m, raw[(i + k + n) % n]);
    wmax[i] = m;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = -h; k <= h; k++) s += wmax[(i + k + n) % n];
    out[i] = s / (2 * h + 1);
  }
  return out;
}

/** Margin (m) the telemetry-edge surface band keeps beyond a car line that leaves the measured edge. */
export const SURFACE_OVER_M = 0.5;

/**
 * Surface-band border (m from the centreline, on `side`) for measured edges `edgeM`: exactly the edge wherever no car
 * line leaves the track, and wider only where one does. Per point the excess is how far the outermost line, plus
 * `overM`, passes the edge (lines inside the edge or beyond LATERAL_LIMIT_M, e.g. in the pit lane, count as 0). Only
 * that excess is smoothed (window max, then moving average, so it still covers the line), so a bulge fades out
 * and the border sits on the edge elsewhere. Smoothing the edge itself, as gainClearance does for the fixed
 * stand-in edges, would push the border up to ~2 m past a real edge.
 */
export function surfaceClearance(
  centre: XY, lines: XY[], side: "left" | "right", edgeM: ArrayLike<number>, overM = SURFACE_OVER_M, half = GAIN_CLEAR_HALF_M,
): Float64Array {
  const n = centre.x.length;
  const excess = new Float64Array(n);
  const sign = side === "left" ? -1 : 1;
  for (const l of lines) {
    const off = lateralOffsets(l, centre);
    for (let i = 0; i < off.length; i++) {
      const out = sign * off[i];
      if (out > edgeM[i] && out <= LATERAL_LIMIT_M && out + overM - edgeM[i] > excess[i]) excess[i] = out + overM - edgeM[i];
    }
  }
  const smooth = smoothClearance(excess, half);
  for (let i = 0; i < n; i++) smooth[i] += edgeM[i];
  return smooth;
}

/**
 * Metres from the centreline, on `side`, that stay clear of the edge (`edgeM`: one value, or one per point) and of either car line plus `marginM`
 * where it runs wider (pit-lane values beyond LATERAL_LIMIT_M are ignored). A window max then a moving average of the
 * same half-width keeps it smooth and never below any point's own clearance (every window holding point i includes
 * a max that saw i).
 */
export function gainClearance(
  centre: XY, lines: XY[], side: "left" | "right" = "left", marginM = 0, edgeM: number | ArrayLike<number> = EDGE_OFFSET_M, half = GAIN_CLEAR_HALF_M,
): Float64Array {
  const n = centre.x.length;
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = typeof edgeM === "number" ? edgeM : edgeM[i];
  const sign = side === "left" ? -1 : 1;
  for (const l of lines) {
    const off = lateralOffsets(l, centre);
    for (let i = 0; i < off.length; i++) {
      const out = sign * off[i];
      if (out <= LATERAL_LIMIT_M && out + marginM > raw[i]) raw[i] = out + marginM;
    }
  }
  return smoothClearance(raw, half);
}

/** Gain/loss line points (x, y, 0 per point) at clearM + extraM along the left normals. */
export function gainPositions(centre: XY, g: GainLine, extraM: number, out: Float32Array = new Float32Array(centre.x.length * 3)): Float32Array {
  for (let i = 0; i < centre.x.length; i++) {
    const d = g.clearM[i] + extraM;
    out[3 * i] = centre.x[i] + g.normals.x[i] * d;
    out[3 * i + 1] = centre.y[i] + g.normals.y[i] * d;
    out[3 * i + 2] = 0;
  }
  return out;
}

export function buildScene(cmp: CompareResponse, opts: SceneOptions = { source: "lateral", gpsHalf: 4 }): Scene {
  // Rounded to 0.01 degree so changing lap or ref on the same track keeps the same frame.
  const o = originOf(cmp.ref.lat, cmp.ref.lon);
  const origin = { lat0: Math.round(o.lat0 * 100) / 100, lon0: Math.round(o.lon0 * 100) / 100 };
  const n = Math.min(cmp.lap.lat.length, cmp.ref.lat.length, cmp.distance.length);
  const raw = (c: CompareResponse["lap"]) => toLocalMetres(c.lat.slice(0, n), c.lon.slice(0, n), origin);
  const lapRaw = raw(cmp.lap), refRaw = raw(cmp.ref);
  // Out/in laps carry pit-lane path_lateral: when exactly one lap is flying, only it defines the centreline.
  const lapIn = { xy: lapRaw, pathLateral: cmp.lap.path_lateral }, refIn = { xy: refRaw, pathLateral: cmp.ref.path_lateral };
  const lapFlying = cmp.lap_kind === "flying", refFlying = cmp.ref_kind === "flying";
  const centre = centreline(lapFlying !== refFlying ? [lapFlying ? lapIn : refIn] : [lapIn, refIn]);
  let lap: XY, ref: XY;
  if (opts.source === "gps") {
    lap = lineFromGps(lapRaw, opts.gpsHalf);
    ref = lineFromGps(refRaw, opts.gpsHalf);
  } else {
    lap = lineFromLateral(centre, cmp.lap.path_lateral, lineFromGps(lapRaw, opts.gpsHalf));
    ref = lineFromLateral(centre, cmp.ref.path_lateral, lineFromGps(refRaw, opts.gpsHalf));
  }
  const normals = normalsLeft(centre, NORMAL_HALF_M);
  const telemetry = opts.edges === "telemetry";
  let edges: [XY, XY] = [offsetLine(centre, EDGE_OFFSET_M), offsetLine(centre, -EDGE_OFFSET_M)];
  let edgeMeasured: Scene["edgeMeasured"] = null;
  let kerbs: Kerb[] = [];
  let floorLeft: number | ArrayLike<number> = EDGE_OFFSET_M, floorRight: number | ArrayLike<number> = EDGE_OFFSET_M;
  if (telemetry) {
    const edgeLap = (c: CompareResponse["lap"]): EdgeLap => ({
      pathLateral: c.path_lateral.slice(0, n), trackEdge: c.track_edge.slice(0, n), kerb: c.kerb.slice(0, n),
    });
    const laps = [edgeLap(cmp.lap), edgeLap(cmp.ref)];
    const te = edgeHalfWidths(laps, n);
    edges = edgeLines(centre, normals, te);
    edgeMeasured = [te.leftMeasured, te.rightMeasured];
    floorLeft = te.left; floorRight = te.right;
    kerbs = kerbRuns(laps, n).map((r) => {
      const half = r.side === "left" ? te.left : te.right, sign = r.side === "left" ? 1 : -1;
      const m = r.end - r.start + 1;
      const x = new Float64Array(m), y = new Float64Array(m);
      for (let k = 0; k < m; k++) {
        const i = r.start + k, d = sign * (half[i] + KERB_OFFSET_M);
        x[k] = centre.x[i] + normals.x[i] * d;
        y[k] = centre.y[i] + normals.y[i] * d;
      }
      return { side: r.side, xy: { x, y }, laps: r.laps };
    });
  }
  const gain: GainLine = {
    normals,
    clearM: gainClearance(centre, [lap, ref], "left", 0, floorLeft),
    rate: gainRate(cmp.delta.slice(0, n)),
  };
  const along = (clear: Float64Array, sign: number): XY => {
    const x = new Float64Array(n), y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      x[i] = centre.x[i] + sign * gain.normals.x[i] * clear[i];
      y[i] = centre.y[i] + sign * gain.normals.y[i] * clear[i];
    }
    return { x, y };
  };
  const border = (side: "left" | "right", floor: number | ArrayLike<number>) =>
    telemetry ? surfaceClearance(centre, [lap, ref], side, floor as ArrayLike<number>) : gainClearance(centre, [lap, ref], side, SURFACE_MARGIN_M, floor);
  const surface: [XY, XY] = [along(border("left", floorLeft), 1), along(border("right", floorRight), -1)];
  return { lap, ref, centre, edges, edgeMeasured, kerbs, gain, surface, bounds: bounds([edges[0], edges[1], lap, ref]) };
}

/**
 * Each car at its own distance-at-time on its own line (the grid index equals metres); heading is the lap car's and refHeading the ref car's.
 * With sync "distance" the ref car is placed at the lap car's distance instead.
 */
export function carPositions(scene: Scene, cmp: CompareResponse, tau: number, sync: CarSync = "time"): { lap: Pt; ref: Pt; heading: number; refHeading: number; dLap: number; dRef: number } {
  const dLap = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const dRef = sync === "distance" ? dLap : distanceAtTime(cmp.ref.t, cmp.distance, tau);
  return { lap: pointAt(scene.lap, dLap), ref: pointAt(scene.ref, dRef), heading: headingAt(scene.lap, dLap), refHeading: headingAt(scene.ref, dRef), dLap, dRef };
}

/**
 * Where a car at fractional grid distance `d` (index = metres) sits on a polyline of `nPoints` points:
 * on segment `segment` (between points `segment` and `segment + 1`), `fraction` 0..1 along it. Clamped to the line.
 */
export function progressSplit(d: number, nPoints: number): { segment: number; fraction: number } {
  if (nPoints < 2 || !(d > 0)) return { segment: 0, fraction: 0 };
  if (d >= nPoints - 1) return { segment: nPoints - 2, fraction: 1 };
  const segment = Math.floor(d);
  return { segment, fraction: d - segment };
}
