import type { CompareResponse } from "../../../api/types";
import { bounds, headingAt, originOf, pointAt, toLocalMetres, type Pt, type XY } from "../../../lib/geo";
import { distanceAtTime } from "../../../lib/playback";
import { centreline, lineFromGps, lineFromLateral } from "../../../lib/racingLine";

/** Everything a renderer draws, in local metres (x east, y north). */
export interface Scene { lap: XY; ref: XY; centre: XY; edges: [XY, XY]; bounds: ReturnType<typeof bounds> }

export type LineSource = "gps" | "lateral";
export type CarSync = "time" | "distance";
export interface SceneOptions { source: LineSource; gpsHalf: number }

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
  // Stand-in edges: the centreline +/- 7 m. Only a drawing load for the renderer benchmark until #36 gives real edges.
  const edges: [XY, XY] = [offsetLine(centre, EDGE_OFFSET_M), offsetLine(centre, -EDGE_OFFSET_M)];
  return { lap, ref, centre, edges, bounds: bounds([edges[0], edges[1], lap, ref]) };
}

/**
 * Each car at its own distance-at-time on its own line (the grid index equals metres); heading is the lap car's and refHeading the ref car's.
 * With sync "distance" the ref car is placed at the lap car's distance instead.
 */
export function carPositions(scene: Scene, cmp: CompareResponse, tau: number, sync: CarSync = "time"): { lap: Pt; ref: Pt; heading: number; refHeading: number } {
  const dLap = distanceAtTime(cmp.lap.t, cmp.distance, tau);
  const dRef = sync === "distance" ? dLap : distanceAtTime(cmp.ref.t, cmp.distance, tau);
  return { lap: pointAt(scene.lap, dLap), ref: pointAt(scene.ref, dRef), heading: headingAt(scene.lap, dLap), refHeading: headingAt(scene.ref, dRef) };
}
