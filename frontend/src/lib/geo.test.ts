import { describe, expect, it } from "vitest";
import { bounds, headingAt, originOf, pointAt, toLocalMetres, type XY } from "./geo";

const xyOf = (xs: number[], ys: number[]): XY => ({ x: Float64Array.from(xs), y: Float64Array.from(ys) });

describe("toLocalMetres", () => {
  it("puts 0.001 deg of latitude 111.19 m apart in y", () => {
    const xy = toLocalMetres([50, 50.001], [5, 5], { lat0: 50, lon0: 5 });
    expect(xy.y[1] - xy.y[0]).toBeCloseTo(111.19, 1);
    expect(Math.abs(xy.x[1] - xy.x[0])).toBeLessThan(1e-9);
  });
  it("uses the shorter of the two inputs", () => {
    expect(toLocalMetres([1, 2, 3], [1, 2], { lat0: 0, lon0: 0 }).x.length).toBe(2);
  });
  it("originOf is the mean", () => {
    expect(originOf([10, 20], [0, 4])).toEqual({ lat0: 15, lon0: 2 });
  });
});

describe("pointAt", () => {
  const xy = xyOf([0, 10, 20, 30], [0, 0, 5, 5]);
  it("interpolates at fractional indices", () => {
    expect(pointAt(xy, 2.5)).toEqual({ x: 25, y: 5 });
    expect(pointAt(xy, 0.5)).toEqual({ x: 5, y: 0 });
  });
  it("clamps to the ends", () => {
    expect(pointAt(xy, -4)).toEqual({ x: 0, y: 0 });
    expect(pointAt(xy, 99)).toEqual({ x: 30, y: 5 });
  });
  it("is the origin for an empty path", () => {
    expect(pointAt(xyOf([], []), 3)).toEqual({ x: 0, y: 0 });
  });
});

describe("headingAt", () => {
  it("is pi/2 on a due-north line", () => {
    const ys = Array.from({ length: 100 }, (_, i) => i);
    expect(headingAt(xyOf(ys.map(() => 0), ys), 50)).toBeCloseTo(Math.PI / 2, 9);
  });
  it("wraps on a closed square loop without a kink", () => {
    const side = 25;
    const xs: number[] = [], ys: number[] = [];
    for (let i = 0; i < side; i++) { xs.push(i * 4); ys.push(0); }
    for (let i = 0; i < side; i++) { xs.push(100); ys.push(i * 4); }
    for (let i = 0; i < side; i++) { xs.push(100 - i * 4); ys.push(100); }
    for (let i = 0; i < side; i++) { xs.push(0); ys.push(100 - i * 4); }
    const xy = xyOf(xs, ys);
    const n = xs.length;
    const h0 = headingAt(xy, 0, 3);
    expect(Number.isFinite(h0)).toBe(true);
    expect(Math.abs(h0 - headingAt(xy, n - 1, 3))).toBeLessThan(0.7);
    expect(headingAt(xy, 0, 3)).toBeCloseTo(headingAt(xy, n, 3), 9);
  });
});

describe("bounds", () => {
  it("spans all paths", () => {
    expect(bounds([xyOf([0, 5], [1, 2]), xyOf([-3, 4], [0, 9])])).toEqual({ minX: -3, maxX: 5, minY: 0, maxY: 9 });
  });
});
