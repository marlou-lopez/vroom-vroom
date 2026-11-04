import { describe, expect, it } from "vitest";
import type { CompareResponse } from "../../../api/types";
import { originOf, pointAt, toLocalMetres } from "../../../lib/geo";
import { buildScene, carPositions } from "./scene";

const R = 6371008.8, DEG = Math.PI / 180, LAT0 = 60, LON0 = 0;

/** Closed circle of radius r metres, one point per metre, as lat/lon (inverse of toLocalMetres around 60N 0E). */
function circle(r: number, n: number) {
  const lat: number[] = [], lon: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n;
    lat.push(LAT0 + (r * Math.sin(a)) / (R * DEG));
    lon.push(LON0 + (r * Math.cos(a)) / (Math.cos(LAT0 * DEG) * R * DEG));
  }
  return { lat, lon };
}

function channels(n: number, lat: number[], lon: number[], t: number[]) {
  const zeros = () => new Array<number>(n).fill(0);
  return { t, lat, lon, speed_kmh: zeros(), throttle: zeros(), brake: zeros(), steering: zeros(), gear: zeros(), rpm: zeros(),
    g_lat: zeros(), g_long: zeros(), yaw_rate: zeros(), path_lateral: zeros(), track_edge: zeros(), kerb: zeros(),
    susp_fl: zeros(), susp_fr: zeros(), susp_rl: zeros(), susp_rr: zeros() };
}

function makeCmp(nLap = 1000, nRef = 999) {
  const n = Math.min(nLap, nRef);
  const a = circle(160, nLap), b = circle(150, nRef);
  const distance = Array.from({ length: nLap }, (_, i) => i);
  const tLap = distance.map((d) => d * 0.1);
  const tRef = Array.from({ length: nRef }, (_, i) => i * 0.1);
  void n;
  return {
    lap_id: "a", ref_lap_id: "b", distance, delta: new Array(nLap).fill(0), warning: null,
    lap_steering_range_deg: null, ref_steering_range_deg: null,
    lap: channels(nLap, a.lat, a.lon, tLap), ref: channels(nRef, b.lat, b.lon, tRef),
  } as unknown as CompareResponse;
}

describe("buildScene", () => {
  const cmp = makeCmp();
  const scene = buildScene(cmp);

  it("uses the shortest input length", () => {
    expect(scene.lap.x.length).toBe(999);
    expect(scene.ref.x.length).toBe(999);
    expect(scene.edges[0].x.length).toBe(999);
    expect(scene.edges[1].y.length).toBe(999);
  });

  it("puts edges 7 m from the centreline on both sides", () => {
    for (const e of scene.edges) {
      for (let i = 0; i < 999; i += 37) {
        expect(Math.hypot(e.x[i] - scene.centre.x[i], e.y[i] - scene.centre.y[i])).toBeCloseTo(7, 2);
      }
    }
  });

  it("bounds cover the edges", () => {
    expect(scene.bounds.maxX - scene.bounds.minX).toBeGreaterThan(300);
  });
});

describe("carPositions", () => {
  const cmp = makeCmp();
  const scene = buildScene(cmp, { source: "gps", gpsHalf: 4 });

  it("starts at the first point", () => {
    const c = carPositions(scene, cmp, 0);
    expect(c.lap.x).toBeCloseTo(scene.lap.x[0], 6);
    expect(c.lap.y).toBeCloseTo(scene.lap.y[0], 6);
    expect(c.ref.x).toBeCloseTo(scene.ref.x[0], 6);
  });

  it("mid-lap sits on the lap's own line, not the ref's", () => {
    const c = carPositions(scene, cmp, 50); // 500 m
    expect(Math.hypot(c.lap.x - scene.lap.x[500], c.lap.y - scene.lap.y[500])).toBeLessThan(0.01);
    let minRef = Infinity;
    for (let i = 0; i < scene.ref.x.length; i++) {
      minRef = Math.min(minRef, Math.hypot(c.lap.x - scene.ref.x[i], c.lap.y - scene.ref.y[i]));
    }
    expect(minRef).toBeGreaterThan(1);
    expect(Number.isFinite(c.heading)).toBe(true);
    expect(Number.isFinite(c.refHeading)).toBe(true);
  });
});

describe("carPositions refHeading", () => {
  it("is the ref line's own travel direction", () => {
    const cmp = makeCmp();
    const scene = buildScene(cmp, { source: "gps", gpsHalf: 4 });
    const c = carPositions(scene, cmp, 50);
    const i = 500;
    const expected = Math.atan2(scene.ref.y[i + 10] - scene.ref.y[i - 10], scene.ref.x[i + 10] - scene.ref.x[i - 10]);
    expect(c.refHeading).toBeCloseTo(expected, 1);
  });
});

describe("line sources", () => {
  it("shared: lap and ref lines are identical", () => {
    const s = buildScene(makeCmp(), { source: "shared", gpsHalf: 4 });
    expect(Array.from(s.lap.x)).toEqual(Array.from(s.ref.x));
    expect(Array.from(s.lap.y)).toEqual(Array.from(s.ref.y));
  });

  it("lateral: +2 and -2 m path_lateral put the lines about 4 m apart", () => {
    const cmp = makeCmp();
    cmp.lap.path_lateral = new Array(1000).fill(2);
    cmp.ref.path_lateral = new Array(999).fill(-2);
    const s = buildScene(cmp, { source: "lateral", gpsHalf: 4 });
    for (let i = 30; i < 970; i += 41) {
      expect(Math.hypot(s.lap.x[i] - s.ref.x[i], s.lap.y[i] - s.ref.y[i])).toBeGreaterThan(3.9);
      expect(Math.hypot(s.lap.x[i] - s.ref.x[i], s.lap.y[i] - s.ref.y[i])).toBeLessThan(4.1);
    }
    expect(s.centre.x.length).toBe(999);
  });

  it("gps with half 0 is the raw local-metres points", () => {
    const cmp = makeCmp();
    const o = originOf(cmp.ref.lat, cmp.ref.lon);
    const raw = toLocalMetres(cmp.lap.lat.slice(0, 999), cmp.lap.lon.slice(0, 999), o);
    const s = buildScene(cmp, { source: "gps", gpsHalf: 0 });
    for (let i = 0; i < 999; i += 50) {
      expect(s.lap.x[i]).toBeCloseTo(raw.x[i], 6);
      expect(s.lap.y[i]).toBeCloseTo(raw.y[i], 6);
    }
  });
});

describe("car sync", () => {
  const cmp = makeCmp();
  cmp.ref.t = cmp.ref.t.map((t) => t * 1.1); // ref is slower, so time sync puts it behind
  const scene = buildScene(cmp, { source: "gps", gpsHalf: 4 });

  it("distance: ref car sits at the lap car's distance on the ref line", () => {
    const c = carPositions(scene, cmp, 50, "distance");
    const p = pointAt(scene.ref, 500);
    expect(c.ref.x).toBeCloseTo(p.x, 6);
    expect(c.ref.y).toBeCloseTo(p.y, 6);
    expect(c.lap.x).toBeCloseTo(pointAt(scene.lap, 500).x, 6);
  });

  it("time (default) puts the slower ref car behind", () => {
    const c = carPositions(scene, cmp, 50);
    const p = pointAt(scene.ref, 500);
    expect(Math.hypot(c.ref.x - p.x, c.ref.y - p.y)).toBeGreaterThan(5);
    const d = carPositions(scene, cmp, 50, "time");
    expect(d.ref).toEqual(c.ref);
  });
});
