const R = 6371008.8;
const DEG = Math.PI / 180;

/** Path in local metres: x east, y north, one sample per metre of lap distance. */
export interface XY { x: Float64Array; y: Float64Array }
/** A point in metres (world) or CSS px (screen). */
export interface Pt { x: number; y: number }
export interface Bounds { minX: number; maxX: number; minY: number; maxY: number }

/** Mean latitude/longitude (degrees) of the samples, used as the local-metres origin. */
export function originOf(lat: ArrayLike<number>, lon: ArrayLike<number>): { lat0: number; lon0: number } {
  const n = Math.min(lat.length, lon.length);
  if (n === 0) return { lat0: 0, lon0: 0 };
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) { a += lat[i]; b += lon[i]; }
  return { lat0: a / n, lon0: b / n };
}

/** Degrees to local metres (equirectangular around origin); length is the shorter input. */
export function toLocalMetres(lat: ArrayLike<number>, lon: ArrayLike<number>, origin: { lat0: number; lon0: number }): XY {
  const n = Math.min(lat.length, lon.length);
  const x = new Float64Array(n), y = new Float64Array(n);
  const k = Math.cos(origin.lat0 * DEG) * R * DEG;
  for (let i = 0; i < n; i++) {
    x[i] = (lon[i] - origin.lon0) * k;
    y[i] = (lat[i] - origin.lat0) * R * DEG;
  }
  return { x, y };
}

/** Position in metres at fractional grid index d (1 index = 1 m), linear and clamped to the path. */
export function pointAt(xy: XY, d: number): Pt {
  const n = xy.x.length;
  if (n === 0) return { x: 0, y: 0 };
  const f = Math.min(Math.max(d, 0), n - 1);
  const i = Math.min(Math.floor(f), n - 1);
  const j = Math.min(i + 1, n - 1);
  const t = f - i;
  return { x: xy.x[i] + (xy.x[j] - xy.x[i]) * t, y: xy.y[i] + (xy.y[j] - xy.y[i]) * t };
}

/** Travel direction in radians (0 = east, pi/2 = north) from the chord d-halfM..d+halfM; indices wrap (closed lap). */
export function headingAt(xy: XY, d: number, halfM = 10): number {
  const n = xy.x.length;
  if (n === 0) return 0;
  const wrap = (i: number) => ((i % n) + n) % n;
  const c = Math.round(d);
  const a = wrap(c - halfM), b = wrap(c + halfM);
  return Math.atan2(xy.y[b] - xy.y[a], xy.x[b] - xy.x[a]);
}

/** Axis-aligned bounds in metres of all paths. */
export function bounds(xys: XY[]): Bounds {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const { x, y } of xys) {
    for (let i = 0; i < x.length; i++) {
      if (x[i] < minX) minX = x[i];
      if (x[i] > maxX) maxX = x[i];
      if (y[i] < minY) minY = y[i];
      if (y[i] > maxY) maxY = y[i];
    }
  }
  if (minX === Infinity) return { minX: 0, maxX: 0, minY: 0, maxY: 0 };
  return { minX, maxX, minY, maxY };
}
