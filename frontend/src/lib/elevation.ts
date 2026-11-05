// Height along a lap from a track captured once through LMU's shared memory (#94).
//
// LMU's recordings have GPS but no elevation. The recording's lat/lon are a fixed transform of the game's
// world x/z (verified on Spa), so a captured path with heights (x, z, y) can be matched to any recording of the
// same track: convert lat/lon to x/z, find the nearest captured point, read its height.
//
// The capture is a list of [x, z, y] points (metres, +y up) resampled every metre, split into laps.

/** Earth radius the recording's GPS transform uses (metres). */
export const EARTH_RADIUS_M = 6371008.8;
const M_PER_DEG = (EARTH_RADIUS_M * Math.PI) / 180;
/** The recording's GPS has latitude 60 degrees at world z = 0 and longitude 0 at x = 0. */
const LAT_ORIGIN = 60;
const COS_LAT_ORIGIN = Math.cos((LAT_ORIGIN * Math.PI) / 180);

/** A lap of the capture: `points[startIndex .. endIndex)` (end exclusive) are consecutive on the path. */
export interface ElevationLap {
  lap: number;
  start_index: number;
  end_index: number;
  lap_time_s: number | null;
}

/** The shape of public/mock/spa-elevation-*.json (written by tools/lmu-logger/decode.py track). */
export interface ElevationTrack {
  source: string;
  track: string | null;
  points: [number, number, number][];
  laps: ElevationLap[];
}

/** Distance (m) beyond which the nearest captured path is not considered the same road. */
export const MAX_MATCH_M = 5;
const CELL_M = 10;
/** Segments longer than this are jumps (a teleport to the garage), not road. */
const MAX_SEGMENT_M = 5;

/** World x/z (metres) for a recording's GPS lat/lon. */
export function latLonToWorld(lat: number, lon: number): { x: number; z: number } {
  return { x: lon * M_PER_DEG * COS_LAT_ORIGIN, z: (lat - LAT_ORIGIN) * M_PER_DEG };
}

/** The recording's GPS lat/lon (degrees) for world x/z (metres): the inverse of latLonToWorld. */
export function worldToLatLon(x: number, z: number): { lat: number; lon: number } {
  return { lat: LAT_ORIGIN + z / M_PER_DEG, lon: x / (M_PER_DEG * COS_LAT_ORIGIN) };
}

export interface ElevationIndex {
  track: ElevationTrack;
  /** Segment starts: segment k joins points[segStart[k]] and points[segStart[k] + 1]. */
  segStart: Int32Array;
  cells: Map<number, number[]>;
}

const cellKey = (cx: number, cz: number) => cx * 100003 + cz;

/** Spatial index (10 m buckets) over the capture's path segments. */
export function buildElevationIndex(track: ElevationTrack): ElevationIndex {
  const starts: number[] = [];
  for (const lap of track.laps) {
    for (let i = lap.start_index; i + 1 < lap.end_index; i++) {
      const a = track.points[i];
      const b = track.points[i + 1];
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) <= MAX_SEGMENT_M) starts.push(i);
    }
  }
  const cells = new Map<number, number[]>();
  const add = (cx: number, cz: number, k: number) => {
    const key = cellKey(cx, cz);
    const list = cells.get(key);
    if (list) {
      if (list[list.length - 1] !== k) list.push(k);
    } else {
      cells.set(key, [k]);
    }
  };
  starts.forEach((i, k) => {
    for (const p of [track.points[i], track.points[i + 1]]) add(Math.floor(p[0] / CELL_M), Math.floor(p[1] / CELL_M), k);
  });
  return { track, segStart: Int32Array.from(starts), cells };
}

/**
 * Height (metres) at world (x, z): the nearest captured segment's height at the closest point on it, or null
 * when nothing is within `maxM`.
 */
export function elevationAt(idx: ElevationIndex, x: number, z: number, maxM = MAX_MATCH_M): number | null {
  const cx = Math.floor(x / CELL_M);
  const cz = Math.floor(z / CELL_M);
  const reach = Math.ceil(maxM / CELL_M);
  let best = Infinity;
  let bestY: number | null = null;
  const pts = idx.track.points;
  for (let dx = -reach; dx <= reach; dx++) {
    for (let dz = -reach; dz <= reach; dz++) {
      const list = idx.cells.get(cellKey(cx + dx, cz + dz));
      if (!list) continue;
      for (const k of list) {
        const i = idx.segStart[k];
        const a = pts[i];
        const b = pts[i + 1];
        const vx = b[0] - a[0];
        const vz = b[1] - a[1];
        const len2 = vx * vx + vz * vz;
        const u = len2 > 0 ? Math.min(1, Math.max(0, ((x - a[0]) * vx + (z - a[1]) * vz) / len2)) : 0;
        const d = Math.hypot(x - (a[0] + u * vx), z - (a[1] + u * vz));
        if (d < best) {
          best = d;
          bestY = a[2] + u * (b[2] - a[2]);
        }
      }
    }
  }
  return best <= maxM ? bestY : null;
}

/** Height at each grid point of a lap given its lat/lon channels; null where the capture has no path nearby. */
export function elevationProfile(
  idx: ElevationIndex, lat: ArrayLike<number>, lon: ArrayLike<number>, maxM = MAX_MATCH_M,
): (number | null)[] {
  const out = new Array<number | null>(lat.length);
  for (let i = 0; i < lat.length; i++) {
    const { x, z } = latLonToWorld(lat[i], lon[i]);
    out[i] = elevationAt(idx, x, z, maxM);
  }
  return out;
}
