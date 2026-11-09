import { describe, expect, it } from "vitest";
import type { TrackMap } from "../api/types";
import { cornerAt, nearestCorner, nearestPoint, nearestPointInWindow, pointAtDistance, polylinePath, projectLatLon, scrubTarget, segmentPath, cornerSegmentPath, smoothClosed, splitWrapping } from "./trackmap";

const map: TrackMap = {
  track_id: "x",
  length_m: 1000,
  landmarks: [],
  corners: [
    { id: "c1", name: "One", start_m: 100, apex_m: 150, end_m: 200, complex: null, approx: false },
    { id: "c2", name: "Wrap", start_m: 950, apex_m: 990, end_m: 30, complex: null, approx: false },
  ],
};

describe("projectLatLon", () => {
  const lat = [50.0, 50.0, 50.01, 50.01];
  const lon = [5.0, 5.04, 5.04, 5.0];
  it("fits inside the box and touches it along the limiting axis", () => {
    const p = projectLatLon(lat, lon, 200, 300);
    for (const v of p.x) expect(v).toBeGreaterThanOrEqual(-1e-9);
    for (const v of p.x) expect(v).toBeLessThanOrEqual(200 + 1e-9);
    for (const v of p.y) expect(v).toBeGreaterThanOrEqual(-1e-9);
    for (const v of p.y) expect(v).toBeLessThanOrEqual(300 + 1e-9);
    expect(Math.max(...p.x) - Math.min(...p.x)).toBeCloseTo(200);
  });
  it("keeps the real aspect ratio (longitude scaled by cos latitude) and north is up", () => {
    const p = projectLatLon(lat, lon, 1000, 1000);
    const w = Math.max(...p.x) - Math.min(...p.x);
    const h = Math.max(...p.y) - Math.min(...p.y);
    expect(w / h).toBeCloseTo((0.04 * Math.cos((50.005 * Math.PI) / 180)) / 0.01, 3);
    expect(p.y[2]).toBeLessThan(p.y[0]);
  });
  it("handles a degenerate single point", () => {
    const p = projectLatLon([1, 1], [2, 2], 100, 100);
    expect(p.x.every(Number.isFinite)).toBe(true);
  });
});

describe("pointAtDistance", () => {
  it("interpolates and clamps", () => {
    const proj = { x: [0, 10, 20], y: [0, 0, 10] };
    const dist = [0, 1, 2];
    expect(pointAtDistance(proj, dist, 0.5)).toEqual({ x: 5, y: 0 });
    expect(pointAtDistance(proj, dist, 1.5)).toEqual({ x: 15, y: 5 });
    expect(pointAtDistance(proj, dist, 99)).toEqual({ x: 20, y: 10 });
    expect(pointAtDistance(proj, dist, -4)).toEqual({ x: 0, y: 0 });
  });
});

describe("cornerAt", () => {
  it("returns the corner inside its range and null on straights", () => {
    expect(cornerAt(map, 150)?.id).toBe("c1");
    expect(cornerAt(map, 500)).toBeNull();
    expect(cornerAt(map, 99)).toBeNull();
  });
  it("handles corners wrapping the start line", () => {
    expect(cornerAt(map, 980)?.id).toBe("c2");
    expect(cornerAt(map, 10)?.id).toBe("c2");
  });
});

describe("segmentPath", () => {
  it("covers the requested range", () => {
    const proj = { x: [0, 1, 2, 3, 4], y: [0, 0, 0, 0, 0] };
    expect(segmentPath(proj, [0, 1, 2, 3, 4], 1, 3)).toBe("M1 0L3 0");
  });
});

describe("nearestPoint", () => {
  const proj = { x: [0, 10, 20, 30], y: [0, 0, 0, 0] };
  it("returns the closest projected point", () => {
    expect(nearestPoint(proj, 11, 3).index).toBe(1);
    expect(nearestPoint(proj, 100, 0).index).toBe(3);
    expect(nearestPoint(proj, 11, 3).dist).toBeCloseTo(Math.hypot(1, 3));
  });
  it("copes with an empty projection", () => {
    expect(nearestPoint({ x: [], y: [] }, 1, 1).index).toBe(-1);
  });
});

describe("nearestCorner", () => {
  it("prefers the containing corner, else the nearest apex", () => {
    expect(nearestCorner(map, 150)?.id).toBe("c1");
    expect(nearestCorner(map, 400)?.id).toBe("c1");
    expect(nearestCorner(map, 800)?.id).toBe("c2");
    expect(nearestCorner({ ...map, corners: [] }, 5)).toBeNull();
  });
});

describe("smoothClosed", () => {
  it("flattens alternating noise on a straight line", () => {
    const n = 400;
    const v = Array.from({ length: n }, (_, i) => i * 0.5 + (i % 2 ? 0.4 : -0.4));
    const o = smoothClosed(v, 8);
    // Interior points (away from the wrap seam) are near the true line.
    for (let i = 20; i < n - 20; i++) expect(Math.abs(o[i] - i * 0.5)).toBeLessThan(0.05);
  });
  it("preserves a smooth circle", () => {
    const n = 1000;
    const x = Array.from({ length: n }, (_, i) => 100 * Math.cos((2 * Math.PI * i) / n));
    const o = smoothClosed(x, 8);
    for (let i = 0; i < n; i++) expect(Math.abs(o[i] - x[i])).toBeLessThan(0.1);
  });
  it("is continuous across the wrap and keeps the length", () => {
    const o = smoothClosed([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 2);
    expect(o).toHaveLength(10);
    expect(o[0]).toBeCloseTo((9 + 10 + 1 + 2 + 3) / 5);
    expect(smoothClosed([], 3)).toEqual([]);
    expect(smoothClosed([5, 5], 8)).toEqual([5, 5]);
  });
});

describe("polylinePath", () => {
  it("always ends at the exact last index and keeps 2 decimals", () => {
    const proj = { x: [0, 1.234, 2, 3.456, 4], y: [0, 0, 0, 0, 0] };
    expect(polylinePath(proj, 0, 4, 2)).toBe("M0 0L2 0L4 0");
    expect(polylinePath(proj, 0, 3, 2)).toBe("M0 0L2 0L3.46 0");
  });
});

describe("nearestPointInWindow", () => {
  // A U-shaped line: out along y=0 (idx 0..9), back along y=1 (idx 10..19), so idx 3 and idx 16 are 1 unit apart.
  const proj = { x: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0], y: [...Array(10).fill(0), ...Array(10).fill(1)] };
  it("matches nearestPoint when the window covers the lap", () => {
    expect(nearestPointInWindow(proj, 3.1, 0.2, 5, 100)).toEqual(nearestPoint(proj, 3.1, 0.2));
  });
  it("ignores a closer point outside the window", () => {
    // (3, 0.9) is nearest to idx 16 globally, but a window around idx 3 only sees the outbound leg.
    expect(nearestPoint(proj, 3, 0.9).index).toBe(16);
    expect(nearestPointInWindow(proj, 3, 0.9, 3, 2).index).toBe(3);
  });
  it("wraps over the start/finish line in both directions", () => {
    // Window around idx 1 with half 3 covers 18, 19, 0, 1, 2, 3, 4.
    expect(nearestPointInWindow(proj, 0.2, 1, 1, 3).index).toBe(19);
    // Window around idx 18 covers 15..19, 0, 1.
    expect(nearestPointInWindow(proj, 1.1, 0, 18, 3).index).toBe(1);
  });
  it("handles an empty projection and a negative or fractional centre", () => {
    expect(nearestPointInWindow({ x: [], y: [] }, 0, 0, 0, 5).index).toBe(-1);
    expect(nearestPointInWindow(proj, 0, 1, -1, 1).index).toBe(19);
    expect(nearestPointInWindow(proj, 3, 0, 3.4, 1).index).toBe(3);
  });
});

describe("scrubTarget", () => {
  const proj = { x: [0, 10, 20, 30, 40, 50, 60, 70], y: [0, 0, 0, 0, 0, 0, 0, 0] };
  it("hits within the threshold and misses beyond it", () => {
    expect(scrubTarget(proj, 11, 3, 5)?.index).toBe(1);
    expect(scrubTarget(proj, 11, 8, 5)).toBeNull();
    expect(scrubTarget({ x: [], y: [] }, 0, 0, 5)).toBeNull();
  });
  it("during a drag it is windowed and has no distance threshold", () => {
    expect(scrubTarget(proj, 59, 50, 5, { index: 3, halfWindow: 2 })?.index).toBe(5);
    expect(scrubTarget(proj, 59, 50, 5, { index: 5, halfWindow: 2 })?.index).toBe(6);
  });
});

describe("splitWrapping", () => {
  it("keeps a normal corner as one interval", () => {
    expect(splitWrapping(100, 220, 7000)).toEqual([[100, 220]]);
  });
  it("splits a corner over the start line into the end of the lap and the start", () => {
    expect(splitWrapping(6900, 120, 7000)).toEqual([[6900, 7000], [0, 120]]);
  });
});

describe("cornerSegmentPath", () => {
  it("draws both halves of a corner over the start line", () => {
    const distance = Array.from({ length: 101 }, (_, i) => i);
    const proj = { x: distance.map((i) => i), y: distance.map(() => 0), w: 100, h: 10 } as unknown as Parameters<typeof segmentPath>[0];
    const d = cornerSegmentPath(proj, distance, 90, 10);
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d).toBe(segmentPath(proj, distance, 90, 100) + segmentPath(proj, distance, 0, 10));
  });
});
