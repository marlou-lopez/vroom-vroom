import type { Corner, TrackMap } from "../api/types";
import { indexAtTime } from "./playback";

export interface Projection {
  x: number[];
  y: number[];
}

/** Equirectangular projection (aspect ratio kept), fitted and centred in a w×h box, north up. */
export function projectLatLon(lat: number[], lon: number[], w: number, h: number): Projection {
  const n = Math.min(lat.length, lon.length);
  if (n === 0) return { x: [], y: [] };
  let latSum = 0;
  for (let i = 0; i < n; i++) latSum += lat[i];
  const cos = Math.cos(((latSum / n) * Math.PI) / 180);
  const rx = new Array<number>(n);
  const ry = new Array<number>(n);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let i = 0; i < n; i++) {
    rx[i] = lon[i] * cos;
    ry[i] = -lat[i];
    if (rx[i] < minX) minX = rx[i];
    if (rx[i] > maxX) maxX = rx[i];
    if (ry[i] < minY) minY = ry[i];
    if (ry[i] > maxY) maxY = ry[i];
  }
  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const scale = Math.min(spanX > 0 ? w / spanX : Infinity, spanY > 0 ? h / spanY : Infinity);
  const k = Number.isFinite(scale) ? scale : 1;
  const offX = (w - spanX * k) / 2;
  const offY = (h - spanY * k) / 2;
  return { x: rx.map((v) => offX + (v - minX) * k), y: ry.map((v) => offY + (v - minY) * k) };
}

/** Point on the projected line at distance `d` (metres), interpolated on the distance grid. */
export function pointAtDistance(proj: Projection, distance: number[], d: number): { x: number; y: number } {
  const n = Math.min(proj.x.length, distance.length);
  if (n === 0) return { x: 0, y: 0 };
  const i = indexAtTime(distance, d);
  if (i >= n - 1) return { x: proj.x[n - 1], y: proj.y[n - 1] };
  const span = distance[i + 1] - distance[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (d - distance[i]) / span)) : 0;
  return { x: proj.x[i] + f * (proj.x[i + 1] - proj.x[i]), y: proj.y[i] + f * (proj.y[i + 1] - proj.y[i]) };
}

/** The corner containing `d` (start_m..end_m, wrapping over the start line), or null on a straight. */
export function cornerAt(map: TrackMap, d: number): Corner | null {
  let best: Corner | null = null;
  for (const c of map.corners) {
    const inside = c.start_m <= c.end_m ? d >= c.start_m && d <= c.end_m : d >= c.start_m || d <= c.end_m;
    if (inside && (best === null || Math.abs(d - c.apex_m) < Math.abs(d - best.apex_m))) best = c;
  }
  return best;
}

const f2 = (v: number) => (Math.round(v * 100) / 100).toString();

/** SVG path of the projected points whose grid index lies in [i0, i1], every `step` points; the last index is always included. */
export function polylinePath(proj: Projection, i0 = 0, i1 = proj.x.length - 1, step = 1): string {
  const parts: string[] = [];
  const first = Math.max(0, i0);
  const last = Math.min(i1, proj.x.length - 1);
  const add = (i: number) => parts.push(`${parts.length ? "L" : "M"}${f2(proj.x[i])} ${f2(proj.y[i])}`);
  let i = first;
  for (; i <= last; i += step) add(i);
  if (last >= first && i - step !== last) add(last);
  return parts.join("");
}

/** Path of a distance range [d0, d1] on a 1 m grid (grid index = distance). */
export function segmentPath(proj: Projection, distance: number[], d0: number, d1: number): string {
  return polylinePath(proj, indexAtTime(distance, d0), indexAtTime(distance, d1), 2);
}

/**
 * Centred moving average of ±`half` samples over a closed loop (indices wrap), so the start and finish do not kink.
 * Removes the GPS quantisation zig-zag. Returns a new array of the same length.
 */
export function smoothClosed(values: ArrayLike<number>, half: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  if (n === 0) return out;
  const h = Math.min(Math.floor(half), Math.floor((n - 1) / 2));
  const win = 2 * h + 1;
  const at = (i: number) => values[((i % n) + n) % n];
  let sum = 0;
  for (let k = -h; k <= h; k++) sum += at(k);
  for (let i = 0; i < n; i++) {
    out[i] = sum / win;
    sum += at(i + h + 1) - at(i - h);
  }
  return out;
}

/** Smoothing half-width (samples, 1 m grid) applied to GPS before projecting. */
export const GPS_SMOOTH_HALF = 8;

/** Closest projected point to (px, py): its grid index and distance. Index is -1 for an empty projection. */
export function nearestPoint(proj: Projection, px: number, py: number): { index: number; dist: number } {
  let index = -1;
  let best = Infinity;
  for (let i = 0; i < proj.x.length; i++) {
    const d2 = (proj.x[i] - px) ** 2 + (proj.y[i] - py) ** 2;
    if (d2 < best) {
      best = d2;
      index = i;
    }
  }
  return { index, dist: Math.sqrt(best) };
}

/** The corner containing `d`, else the one with the nearest apex; null when the map has no corners. */
export function nearestCorner(map: TrackMap, d: number): Corner | null {
  const inside = cornerAt(map, d);
  if (inside) return inside;
  let best: Corner | null = null;
  for (const c of map.corners) if (best === null || Math.abs(d - c.apex_m) < Math.abs(d - best.apex_m)) best = c;
  return best;
}

/** How close (screen pixels) a pointer must be to the line to hover or grab it. */
export const MAP_HIT_PX = 12;
/** While dragging, only grid indices within this many metres of the current one are considered. */
export const SCRUB_WINDOW_M = 150;

/**
 * Like `nearestPoint`, but only over the grid indices within ±`halfWindow` of `centerIdx`, wrapping over the
 * start/finish line (the lap is a closed loop). Keeps a drag on the section it started on when the track
 * passes close to itself. A window covering the whole lap is the same as `nearestPoint`.
 */
export function nearestPointInWindow(
  proj: Projection, px: number, py: number, centerIdx: number, halfWindow: number,
): { index: number; dist: number } {
  const n = Math.min(proj.x.length, proj.y.length);
  if (n === 0) return { index: -1, dist: Infinity };
  const half = Math.min(Math.max(0, Math.floor(halfWindow)), Math.floor(n / 2));
  const count = Math.min(n, 2 * half + 1);
  let index = -1;
  let best = Infinity;
  for (let k = 0; k < count; k++) {
    const i = (((Math.round(centerIdx) - half + k) % n) + n) % n;
    const d2 = (proj.x[i] - px) ** 2 + (proj.y[i] - py) ** 2;
    if (d2 < best) {
      best = d2;
      index = i;
    }
  }
  return { index, dist: Math.sqrt(best) };
}

/**
 * The point to scrub to for a pointer at (px, py) in map units. With `center` (a drag in progress) the search is
 * windowed around it and always succeeds; without it the whole lap is searched and the pointer must be within
 * `maxDist` map units of the line, else null.
 */
export function scrubTarget(
  proj: Projection, px: number, py: number, maxDist: number, center?: { index: number; halfWindow: number },
): { index: number; dist: number } | null {
  const hit = center ? nearestPointInWindow(proj, px, py, center.index, center.halfWindow) : nearestPoint(proj, px, py);
  if (hit.index < 0) return null;
  return center || hit.dist <= maxDist ? hit : null;
}

/** A corner's `[start, end]` as one or two intervals on a lap of `length`: one that wraps over the start line (start > end) is split at the line. */
export function splitWrapping(start: number, end: number, length: number): Array<[number, number]> {
  if (start <= end) return [[start, end]];
  return [[start, length], [0, end]];
}

/** Path of a corner's range, both halves when it wraps over the start line. */
export function cornerSegmentPath(proj: Projection, distance: number[], start: number, end: number): string {
  return splitWrapping(start, end, distance[distance.length - 1]).map(([d0, d1]) => segmentPath(proj, distance, d0, d1)).join("");
}
