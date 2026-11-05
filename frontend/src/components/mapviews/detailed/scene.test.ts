import { describe, expect, it } from "vitest";
import type { CompareResponse } from "../../../api/types";
import { originOf, pointAt, toLocalMetres } from "../../../lib/geo";
import { lateralOffsets } from "../../../lib/racingLine";
import { KERB_OFFSET_M, buildScene, carPositions, progressSplit, surfaceClearance } from "./scene";

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
    lap_id: "a", ref_lap_id: "b", lap_kind: "flying", ref_kind: "flying", distance, delta: new Array(nLap).fill(0), warning: null,
    lap_steering_range_deg: null, ref_steering_range_deg: null, lap_car_dims: null, ref_car_dims: null,
    lap: channels(nLap, a.lat, a.lon, tLap), ref: channels(nRef, b.lat, b.lon, tRef),
  } as unknown as CompareResponse;
}

describe("buildScene", () => {
  const cmp = makeCmp();
  const scene = buildScene(cmp);
  it("passes the contract's dims through and falls back to the generic GT3 size for null", () => {
    const base = buildScene(cmp);
    expect(base.lapDims).toEqual({ length_m: 4.7, width_m: 2 });
    expect(base.refDims).toEqual({ length_m: 4.7, width_m: 2 });
    const s = buildScene({ ...cmp, lap_car_dims: { length_m: 4.96, width_m: 2.04 } });
    expect(s.lapDims).toEqual({ length_m: 4.96, width_m: 2.04 });
    expect(s.refDims).toEqual({ length_m: 4.7, width_m: 2 });
  });

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

describe("scene frame", () => {
  it("is the same for two different refs on the same track", () => {
    const a = makeCmp();
    const b = makeCmp();
    b.ref.lat = b.ref.lat.map((v) => v + 0.00003); // a different ref: ~3 m north, shifts its mean
    b.ref.lon = b.ref.lon.map((v) => v + 0.00003);
    const sa = buildScene(a, { source: "gps", gpsHalf: 0 }), sb = buildScene(b, { source: "gps", gpsHalf: 0 });
    // the lap is identical in both, so with a shared frame its line is identical
    for (let i = 0; i < 999; i += 50) {
      expect(sb.lap.x[i]).toBeCloseTo(sa.lap.x[i], 9);
      expect(sb.lap.y[i]).toBeCloseTo(sa.lap.y[i], 9);
    }
  });
});

describe("line sources", () => {
  it("lateral: +2 and -2 m path_lateral put the lines about 4 m apart", () => {
    const cmp = makeCmp();
    cmp.lap.path_lateral = new Array(1000).fill(2);
    cmp.ref.path_lateral = new Array(999).fill(-2);
    // consistent data (both imply a centre at r = 158), so the GPS blend stays out of it
    const r156 = circle(156, 999);
    cmp.ref.lat = r156.lat; cmp.ref.lon = r156.lon;
    const s = buildScene(cmp, { source: "lateral", gpsHalf: 4 });
    for (let i = 30; i < 970; i += 41) {
      expect(Math.hypot(s.lap.x[i] - s.ref.x[i], s.lap.y[i] - s.ref.y[i])).toBeGreaterThan(3.9);
      expect(Math.hypot(s.lap.x[i] - s.ref.x[i], s.lap.y[i] - s.ref.y[i])).toBeLessThan(4.1);
    }
    expect(s.centre.x.length).toBe(999);
  });

  it("centreline uses only the flying lap when exactly one is flying", () => {
    const cmp = makeCmp();
    cmp.lap.path_lateral = new Array(1000).fill(2);
    cmp.ref.path_lateral = new Array(999).fill(-2);
    const both = buildScene(cmp).centre;
    const one = buildScene({ ...cmp, ref_kind: "out" }).centre;
    const other = buildScene({ ...cmp, lap_kind: "in" }).centre;
    // lap alone: circle r=160 with pl=+2 -> centre r=158; ref alone: r=150 with pl=-2 -> r=152
    expect(Math.hypot(one.x[100], one.y[100])).toBeCloseTo(158, 0);
    expect(Math.hypot(other.x[100], other.y[100])).toBeCloseTo(152, 0);
    expect(Math.hypot(both.x[100], both.y[100])).toBeCloseTo(155, 0);
    const neither = buildScene({ ...cmp, lap_kind: "out", ref_kind: "in" }).centre;
    expect(Math.hypot(neither.x[100], neither.y[100])).toBeCloseTo(155, 0);
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

describe("progressSplit", () => {
  it("splits a fractional distance into segment and fraction", () => {
    const s = progressSplit(12.25, 100);
    expect(s.segment).toBe(12);
    expect(s.fraction).toBeCloseTo(0.25, 9);
  });
  it("an integer distance is the start of its segment", () => {
    expect(progressSplit(12, 100)).toEqual({ segment: 12, fraction: 0 });
  });
  it("clamps at the start", () => {
    expect(progressSplit(0, 100)).toEqual({ segment: 0, fraction: 0 });
    expect(progressSplit(-5, 100)).toEqual({ segment: 0, fraction: 0 });
  });
  it("clamps at the end to the last segment, fully driven", () => {
    expect(progressSplit(99, 100)).toEqual({ segment: 98, fraction: 1 });
    expect(progressSplit(250, 100)).toEqual({ segment: 98, fraction: 1 });
  });
  it("handles tiny polylines", () => {
    expect(progressSplit(5, 0)).toEqual({ segment: 0, fraction: 0 });
    expect(progressSplit(5, 1)).toEqual({ segment: 0, fraction: 0 });
    expect(progressSplit(0.5, 2)).toEqual({ segment: 0, fraction: 0.5 });
    expect(progressSplit(3, 2)).toEqual({ segment: 0, fraction: 1 });
  });
});

describe("carPositions distances", () => {
  const cmp = makeCmp();
  cmp.ref.t = cmp.ref.t.map((t) => t * 1.1);
  const scene = buildScene(cmp, { source: "gps", gpsHalf: 4 });
  it("returns each car's grid distance; distance sync makes them equal", () => {
    const c = carPositions(scene, cmp, 50);
    expect(c.dLap).toBeCloseTo(500, 0);
    expect(c.dRef).toBeLessThan(c.dLap);
    const d = carPositions(scene, cmp, 50, "distance");
    expect(d.dRef).toBe(d.dLap);
  });
});

describe("edges: stand-in and telemetry", () => {
  const withEdges = () => {
    const cmp = makeCmp();
    cmp.lap.path_lateral = new Array(1000).fill(2);
    cmp.lap.track_edge = new Array(1000).fill(5); // right side, 5 m
    cmp.ref.path_lateral = new Array(999).fill(-2);
    cmp.ref.track_edge = new Array(999).fill(-4); // left side, 4 m
    for (let i = 100; i <= 120; i++) cmp.lap.kerb[i] = 1; // a right-hand kerb
    return cmp;
  };

  it("stand-in has no measured flags and no kerbs", () => {
    const s = buildScene(withEdges());
    expect(s.edgeMeasured).toBeNull();
    expect(s.kerbs).toEqual([]);
    expect(buildScene(withEdges(), { source: "lateral", gpsHalf: 4, edges: "stand-in" }).kerbs).toEqual([]);
  });

  it("telemetry puts the left edge left and the right edge right, at the measured half-widths", () => {
    const s = buildScene(withEdges(), { source: "lateral", gpsHalf: 4, edges: "telemetry" });
    const left = lateralOffsets(s.edges[0], s.centre), right = lateralOffsets(s.edges[1], s.centre);
    for (let i = 20; i < 980; i += 37) {
      expect(left[i]).toBeCloseTo(-4, 1);
      expect(right[i]).toBeCloseTo(5, 1);
    }
    expect(s.edgeMeasured![0][500]).toBe(1);
    expect(s.edgeMeasured![1][500]).toBe(1);
  });

  it("puts a right-hand kerb KERB_W_M / 2 outside the right edge, its inner side on the edge line", () => {
    const s = buildScene(withEdges(), { source: "lateral", gpsHalf: 4, edges: "telemetry" });
    expect(s.kerbs).toHaveLength(1);
    const k = s.kerbs[0];
    expect(k.side).toBe("right");
    expect(k.xy.x.length).toBe(21);
    // Distance from the centre point it was placed against, and on the same side as the right edge.
    const re = lateralOffsets(s.edges[1], s.centre);
    for (let j = 0; j < 21; j++) {
      const i = 100 + j;
      expect(Math.hypot(k.xy.x[j] - s.centre.x[i], k.xy.y[j] - s.centre.y[i])).toBeCloseTo(5 + KERB_OFFSET_M, 1);
      expect(Math.hypot(k.xy.x[j] - s.edges[1].x[i], k.xy.y[j] - s.edges[1].y[i])).toBeCloseTo(KERB_OFFSET_M, 1);
      expect(re[i]).toBeGreaterThan(0);
    }
  });

  it("the gain/loss clearance follows the real edges", () => {
    const s = buildScene(withEdges(), { source: "lateral", gpsHalf: 4, edges: "telemetry" });
    // Left floor is 4 m, not the stand-in 7 m; the lines sit near the centre, so the clearance stays well under 7.
    expect(s.gain.clearM[500]).toBeLessThan(6.5);
  });
});

describe("surfaceClearance", () => {
  // Counter-clockwise circle: left of travel is inward, right is outward.
  const N = 628, R0 = 100;
  const ring = (radius: (i: number) => number) => {
    const x = new Float64Array(N), y = new Float64Array(N);
    for (let i = 0; i < N; i++) { const a = (2 * Math.PI * i) / N, r = radius(i); x[i] = r * Math.cos(a); y[i] = r * Math.sin(a); }
    return { x, y };
  };
  const centre = ring(() => R0);
  const edge = new Float64Array(N).fill(5);
  const half = 20;
  const near = (i: number, c: number) => Math.min(Math.abs(i - c), N - Math.abs(i - c));

  it("equals the edge when the lines stay inside it", () => {
    const inside = ring(() => R0 + 3), insideL = ring(() => R0 - 4);
    for (const side of ["left", "right"] as const) {
      const r = surfaceClearance(centre, [inside, insideL], side, edge);
      for (let i = 0; i < N; i += 7) expect(r[i]).toBeCloseTo(5, 6);
    }
  });

  it("widens to cover a line that goes 1 m past the right edge, and is the edge far away", () => {
    const out = ring((i) => R0 + (i >= 300 && i <= 330 ? 6 : 0));
    const r = surfaceClearance(centre, [out], "right", edge);
    for (let i = 300; i <= 330; i++) expect(r[i]).toBeGreaterThanOrEqual(6.5 - 1e-9);
    for (let i = 0; i < N; i++) if (near(i, 315) > 15 + 2 * half) expect(r[i]).toBeCloseTo(5, 6);
    // The other side is untouched.
    const l = surfaceClearance(centre, [out], "left", edge);
    for (let i = 0; i < N; i += 7) expect(l[i]).toBeCloseTo(5, 6);
  });

  it("works on the left side too", () => {
    const out = ring((i) => R0 - (i >= 300 && i <= 330 ? 6 : 0));
    const r = surfaceClearance(centre, [out], "left", edge);
    for (let i = 300; i <= 330; i++) expect(r[i]).toBeGreaterThanOrEqual(6.5 - 1e-9);
    for (let i = 0; i < N; i++) if (near(i, 315) > 15 + 2 * half) expect(r[i]).toBeCloseTo(5, 6);
  });
});
