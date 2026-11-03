import type { CompareResponse } from "../api/types";
import { GPS_SMOOTH_HALF, polylinePath, projectLatLon, smoothClosed, type Projection } from "./trackmap";
import { scrubberPath } from "./playback";

export const MAP_W = 200;
export const MAP_H = 240;
export const MAP_PAD = 10;

/** Everything derived from one comparison that does not change with the playhead. Built once per `CompareResponse`. */
export interface PlaybackModel {
  cmp: CompareResponse;
  proj: Projection;
  mapPath: string;
  scrubPath: string;
  duration: number;
  speedRange: [number, number];
}

export function buildModel(cmp: CompareResponse): PlaybackModel {
  // The map comes from the comparison lap's GPS.
  const proj = projectLatLon(smoothClosed(cmp.ref.lat, GPS_SMOOTH_HALF), smoothClosed(cmp.ref.lon, GPS_SMOOTH_HALF), MAP_W, MAP_H);
  let lo = Infinity;
  let hi = -Infinity;
  for (const arr of [cmp.lap.speed_kmh, cmp.ref.speed_kmh]) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] < lo) lo = arr[i];
      if (arr[i] > hi) hi = arr[i];
    }
  }
  if (!Number.isFinite(lo)) [lo, hi] = [0, 300];
  return {
    cmp,
    proj,
    mapPath: polylinePath(proj, 0, proj.x.length - 1, 2),
    scrubPath: scrubberPath(cmp.lap.t, cmp.delta),
    duration: cmp.lap.t[cmp.lap.t.length - 1] ?? 0,
    speedRange: [Math.floor(lo / 20) * 20, Math.ceil(hi / 20) * 20],
  };
}
