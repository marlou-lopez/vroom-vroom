// Synthetic Spa-shaped laps. Only the Monza mock session still uses them (stretched); Spa itself is real data now.
// Ported from the Playback and Tracks mockups
// (speed-envelope model, pedals, steering, gear, map polygon) at a 1 m grid instead of 10 m.
import type { ChannelArrays, GridChannel } from "../types";

export const SPA_TRACK_ID = "spa-francorchamps-grand-prix";
export const SPA_LENGTH_M = 7004;
/** Grid points: distance 0..7003 inclusive. */
export const SPA_GRID_LEN = 7004;
/** Lap time of the canonical reference lap in the mockups (2:22.910). */
export const SPA_REF_TIME_S = 142.91;

interface ModelCorner {
  id: string;
  name: string;
  apex: number;
  v: number; // reference apex speed, km/h
  dv: number; // slow-lap apex speed delta, km/h
  early?: boolean; // slow lap brakes earlier (gentler decel)
  straight?: boolean; // Kemmel: a kink, no speed minimum
}

// The 14 model corners of the Playback mockup; 13 are real corners (Kemmel is flat).
const MODEL: ModelCorner[] = [
  { id: "lasource", name: "La Source", apex: 330, v: 72, dv: -3, early: true },
  { id: "raidillon", name: "Raidillon", apex: 1080, v: 232, dv: -4 },
  { id: "kemmel", name: "Kemmel", apex: 1700, v: 268, dv: 0, straight: true },
  { id: "lescombes", name: "Les Combes", apex: 2280, v: 118, dv: -2, early: true },
  { id: "malmedy", name: "Malmedy", apex: 2450, v: 140, dv: 0 },
  { id: "bruxelles", name: "Bruxelles", apex: 2910, v: 84, dv: -2, early: true },
  { id: "t9", name: "T9", apex: 3150, v: 158, dv: 0 },
  { id: "pouhon", name: "Pouhon", apex: 3640, v: 165, dv: -9 },
  { id: "fagnes", name: "Fagnes", apex: 4150, v: 116, dv: -1, early: true },
  { id: "campus", name: "Campus", apex: 4550, v: 132, dv: 0 },
  { id: "stavelot", name: "Stavelot", apex: 4800, v: 150, dv: -1 },
  { id: "paulfrere", name: "Paul Frère", apex: 5300, v: 176, dv: 0 },
  { id: "blanchimont", name: "Blanchimont", apex: 5900, v: 244, dv: 5 },
  { id: "busstop", name: "Bus Stop", apex: 6660, v: 70, dv: -4, early: true },
];
const SPEED_CORNERS = MODEL.filter((c) => !c.straight);
const VMAX = 268 / 3.6;
const L = SPA_LENGTH_M;
const N = SPA_GRID_LEN;

// Map polygon [x, y, lap distance], from the mockups (x/y in their 3x / 2.6x drawing units).
const POLY: [number, number, number][] = [
  [49, 12, 0], [43, 4, 280], [39, 5, 330], [37, 8, 400], [30, 16, 1000], [26, 22, 1120], [11, 44, 2150],
  [8, 48, 2250], [11, 52, 2330], [10, 58, 2450], [14, 65, 2880], [19, 63, 2950], [24, 66, 3150], [26, 74, 3550],
  [31, 80, 3700], [38, 78, 4100], [42, 82, 4200], [48, 90, 4550], [55, 91, 4800], [60, 82, 5300], [64, 60, 5900],
  [62, 40, 6300], [60, 28, 6600], [57, 26, 6650], [56, 22, 6700], [49, 12, 7004],
];

// ---- speed model ----

function profile(slow: boolean): Float64Array {
  const v = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let best = VMAX;
    for (const c of SPEED_CORNERS) {
      const vm = (c.v + (slow ? c.dv : 0)) / 3.6;
      for (const off of [-L, 0, L]) {
        const dd = i - (c.apex + off);
        const a = dd < 0 ? (slow && c.early ? 11.5 : 14) : 3.6;
        const val = Math.sqrt(vm * vm + 2 * a * Math.abs(dd));
        if (val < best) best = val;
      }
    }
    v[i] = best;
  }
  return v;
}

function cumulativeTime(v: Float64Array): Float64Array {
  const t = new Float64Array(N);
  for (let i = 1; i < N; i++) t[i] = t[i - 1] + 1 / ((v[i] + v[i - 1]) / 2);
  return t;
}

function pedals(v: Float64Array): { thr: number[]; brk: number[]; acc: number[] } {
  const thr = new Array<number>(N);
  const brk = new Array<number>(N);
  const accs = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    const j = Math.min(i + 1, N - 1);
    const h = Math.max(i - 1, 0);
    const acc = (v[j] * v[j] - v[h] * v[h]) / (2 * (j - h));
    accs[i] = acc;
    if (acc < -2.5) { thr[i] = 0; brk[i] = Math.min(1, -acc / 14); }
    else if (acc > 0.3 || v[i] >= VMAX - 0.05) { thr[i] = 1; brk[i] = 0; }
    else { thr[i] = 0.3; brk[i] = 0; }
  }
  return { thr, brk, acc: accs };
}

function steering(slow: boolean): number[] {
  const s = new Array<number>(N).fill(0);
  SPEED_CORNERS.forEach((c, ci) => {
    const sign = ci % 2 ? -1 : 1;
    const amp = Math.min(0.9, 0.12 + 28 / c.v);
    for (let i = Math.max(0, c.apex - 300); i <= Math.min(N - 1, c.apex + 300); i++) {
      const dd = i - c.apex;
      let val = sign * amp * Math.exp(-Math.pow(dd / 70, 2));
      if (slow && c.id === "pouhon") val += 0.06 * Math.sin(dd / 9) * Math.exp(-Math.pow(dd / 90, 2));
      s[i] += val;
    }
  });
  return s.map((x) => Math.max(-1, Math.min(1, x)));
}

const gearOf = (kmh: number) => (kmh < 90 ? 2 : kmh < 125 ? 3 : kmh < 160 ? 4 : kmh < 200 ? 5 : kmh < 235 ? 6 : 7);
const KMH_PER_KRPM: Record<number, number> = { 2: 14, 3: 19, 4: 24, 5: 30, 6: 36, 7: 42 };

// ---- GPS: polygon mapped around Spa (an approximate shape, not real GPS) ----

function latLon(): { lat: number[]; lon: number[] } {
  const pts = POLY.map(([x, y, d]) => ({ x: x * 3 + 8, y: y * 2.6 + 8, d }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const metresPerUnit = 10;
  const lat0 = 50.437;
  const lon0 = 5.971;
  const mPerDegLat = 111_320;
  const mPerDegLon = 111_320 * Math.cos((lat0 * Math.PI) / 180);
  const lat = new Array<number>(N);
  const lon = new Array<number>(N);
  let j = 0;
  for (let i = 0; i < N; i++) {
    while (j < pts.length - 2 && i > pts[j + 1].d) j++;
    const f = Math.max(0, Math.min(1, (i - pts[j].d) / (pts[j + 1].d - pts[j].d)));
    const x = pts[j].x + f * (pts[j + 1].x - pts[j].x);
    const y = pts[j].y + f * (pts[j + 1].y - pts[j].y);
    lat[i] = lat0 - ((y - cy) * metresPerUnit) / mPerDegLat; // drawing y grows downwards, latitude upwards
    lon[i] = lon0 + ((x - cx) * metresPerUnit) / mPerDegLon;
  }
  return { lat, lon };
}

// ---- shared base (computed once) ----

interface Base {
  distance: number[];
  tr: Float64Array; // reference time at canonical lap time 142.91
  s: Float64Array; // normalised slow-lap delta shape, 0 -> 1
  ref: { speed: number[]; thr: number[]; brk: number[]; st: number[]; gear: number[]; gLong: number[] };
  slow: { speed: number[]; thr: number[]; brk: number[]; st: number[]; gear: number[]; gLong: number[] };
  lat: number[];
  lon: number[];
  zeros: number[];
  edge: number[];
}

let baseCache: Base | undefined;

function base(): Base {
  if (baseCache) return baseCache;
  const vr = profile(false);
  const vl = profile(true);
  const tr0 = cumulativeTime(vr);
  const tl0 = cumulativeTime(vl);
  const k = SPA_REF_TIME_S / tr0[N - 1];
  const tr = tr0.map((x) => x * k);
  const raw = tl0.map((x, i) => x * k - tr[i]);
  const last = raw[N - 1];
  const s = raw.map((x) => x / last);
  const part = (v: Float64Array, slow: boolean) => {
    const p = pedals(v);
    const speed = Array.from(v, (x) => x * 3.6);
    return { speed, thr: p.thr, brk: p.brk, st: steering(slow), gear: speed.map(gearOf), gLong: p.acc.map((a) => a / 9.81) };
  };
  const { lat, lon } = latLon();
  baseCache = {
    distance: Array.from({ length: N }, (_, i) => i),
    tr, s,
    ref: part(vr, false),
    slow: part(vl, true),
    lat, lon,
    zeros: new Array<number>(N).fill(0),
    edge: new Array<number>(N).fill(7),
  };
  return baseCache;
}

const lapCache = new Map<string, { distance: number[]; ch: ChannelArrays }>();

/**
 * A mock Spa lap on a 1 m grid (7004 points). `t` is strictly increasing, starts at 0 and ends at `lapTimeS`.
 * `slow` follows the mockup's slower lap (lower apex speeds, earlier braking, extra Pouhon corrections);
 * its delta to the 142.91 s `ref` lap has the mockup's shape. Arrays are shared between calls: treat as read-only.
 */
export function makeSpaLap(opts: { lapTimeS: number; variant: "ref" | "slow" }): { distance: number[]; ch: ChannelArrays } {
  const key = `${opts.variant}:${opts.lapTimeS}`;
  const hit = lapCache.get(key);
  if (hit) return hit;
  const b = base();
  const slow = opts.variant === "slow";
  const src = slow ? b.slow : b.ref;
  const T = opts.lapTimeS;
  const D = T - SPA_REF_TIME_S;
  const t = new Array<number>(N);
  if (slow) {
    for (let i = 0; i < N; i++) t[i] = b.tr[i] + D * b.s[i];
  } else {
    const f = T / b.tr[N - 1];
    for (let i = 0; i < N; i++) t[i] = b.tr[i] * f;
  }
  t[N - 1] = T; // exact, whatever the float rounding
  const gLat = src.st.map((st, i) => st * 3.5 * (src.speed[i] / 200));
  const yaw = gLat.map((g, i) => (g * 9.81) / Math.max(src.speed[i] / 3.6, 5));
  const rpm = src.speed.map((v, i) => Math.round(Math.max(3000, Math.min(8500, (v / KMH_PER_KRPM[src.gear[i]]) * 1000))));
  const ch: Record<GridChannel, number[]> = {
    t,
    speed_kmh: src.speed,
    throttle: src.thr,
    brake: src.brk,
    steering: src.st,
    gear: src.gear,
    rpm,
    g_lat: gLat,
    g_long: src.gLong,
    yaw_rate: yaw,
    lat: b.lat,
    lon: b.lon,
    path_lateral: b.zeros,
    track_edge: b.edge,
    kerb: b.zeros,
    susp_fl: b.zeros,
    susp_fr: b.zeros,
    susp_rl: b.zeros,
    susp_rr: b.zeros,
  };
  const lap = { distance: b.distance, ch };
  lapCache.set(key, lap);
  return lap;
}
