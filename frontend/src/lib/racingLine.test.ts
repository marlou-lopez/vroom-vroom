import { describe, expect, it } from "vitest";
import type { TrackMap } from "../api/types";
import type { XY } from "./geo";
import { centreline, distStats, lateralOffsets, lineFromLateral, normalsLeft, straightMask } from "./racingLine";

const R = 100;
const N = Math.round(2 * Math.PI * R);

/** Counter-clockwise circle of radius r around the origin, N points. */
function circle(r: number): XY {
  const x = new Float64Array(N), y = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const a = (2 * Math.PI * i) / N;
    x[i] = r * Math.cos(a);
    y[i] = r * Math.sin(a);
  }
  return { x, y };
}
const radius = (p: XY, i: number) => Math.hypot(p.x[i], p.y[i]);
const fill = (v: number) => new Array<number>(N).fill(v);

describe("racingLine", () => {
  it("normalsLeft points to the centre of a counter-clockwise circle", () => {
    const c = circle(R);
    const nl = normalsLeft(c);
    for (const i of [0, 1, 157, N - 1]) {
      expect(Math.hypot(nl.x[i], nl.y[i])).toBeCloseTo(1, 9);
      expect(nl.x[i] * -c.x[i] + nl.y[i] * -c.y[i]).toBeGreaterThan(R * 0.999);
    }
  });

  it("lineFromLateral with pl = +2 lies on r = 102 (right of travel is outward when counter-clockwise)", () => {
    const line = lineFromLateral(circle(R), fill(2));
    for (let i = 0; i < N; i++) expect(Math.abs(radius(line, i) - 102)).toBeLessThan(0.01);
  });

  it("centreline of laps at pl = +2 and -2 recovers r = 100 with no kink at the wrap", () => {
    const laps = [
      { xy: circle(102), pathLateral: fill(2) },
      { xy: circle(98), pathLateral: fill(-2) },
    ];
    const c = centreline(laps);
    for (const i of [0, 1, 2, 3, N - 3, N - 2, N - 1]) expect(Math.abs(radius(c, i) - R)).toBeLessThan(0.05);
    const off = lateralOffsets(circle(102), c);
    expect(off[0]).toBeCloseTo(2, 1);
  });

  it("falls back to the fallback point where |pl| > 15", () => {
    const fb = circle(102.5);
    const pl = fill(2);
    pl[10] = 20;
    const line = lineFromLateral(circle(R), pl, fb);
    expect(line.x[10]).toBe(fb.x[10]);
    expect(line.y[10]).toBe(fb.y[10]);
    expect(Math.abs(radius(line, 11) - 102)).toBeLessThan(0.01);
  });

  it("blends toward the fallback as lateral and fallback disagree by 1..3 m", () => {
    const fb = circle(R);
    const push = (i: number, r: number) => { fb.x[i] *= r / R; fb.y[i] *= r / R; };
    push(20, 102.5); // lateral is on r = 102: d = 0.5
    push(40, 104);   // d = 2
    push(60, 107);   // d = 5
    const line = lineFromLateral(circle(R), fill(2), fb);
    expect(radius(line, 20)).toBeCloseTo(102, 2);
    expect(radius(line, 40)).toBeCloseTo(103, 2);
    expect(line.x[60]).toBeCloseTo(fb.x[60], 6);
    expect(line.y[60]).toBeCloseTo(fb.y[60], 6);
  });

  it("straightMask excludes a corner that wraps over the line, with its margin, and drops short runs", () => {
    const corner = (id: string, start_m: number, end_m: number) => ({ id, name: id, start_m, apex_m: start_m, end_m, complex: null, approx: false });
    const map: TrackMap = { track_id: "t", length_m: 1000, landmarks: [], corners: [corner("a", 950, 30), corner("b", 400, 450)] };
    const m = straightMask(map, 1000);
    expect(m[0]).toBe(false);
    expect(m[999]).toBe(false);
    expect(m[79]).toBe(false);
    expect(m[81]).toBe(true);
    expect(m[899]).toBe(true);
    expect(m[900]).toBe(false);
    expect(m[300]).toBe(true);
    expect(m[349]).toBe(true);
    expect(m[350]).toBe(false);
    expect(m[500]).toBe(false);
    expect(m[501]).toBe(true);
    // free runs: 80..349 (270 m) and 501..899 (399 m); a 300 m minimum drops only the first
    const long = straightMask(map, 1000, 300);
    expect(long[300]).toBe(false);
    expect(long[600]).toBe(true);
    expect(straightMask(map, 1000, 500).some(Boolean)).toBe(false);
  });

  it("straightMask keeps a free run that crosses index n-1 -> 0", () => {
    const map: TrackMap = { track_id: "t", length_m: 1000, landmarks: [], corners: [{ id: "a", name: "a", start_m: 400, apex_m: 450, end_m: 500, complex: null, approx: false }] };
    const m = straightMask(map, 1000);
    expect(m[0]).toBe(true);
    expect(m[999]).toBe(true);
    expect(m[349]).toBe(true);
    expect(m[351]).toBe(false);
  });

  it("distStats uses ceil(0.95 n) - 1 for p95, honours the mask and is zero when empty", () => {
    const v = Array.from({ length: 20 }, (_, i) => i + 1);
    expect(distStats(v)).toEqual({ mean: 10.5, p95: 19, max: 20, n: 20 });
    expect(distStats(v, v.map((x) => x <= 10))).toEqual({ mean: 5.5, p95: 10, max: 10, n: 10 });
    expect(distStats(v, v.map(() => false))).toEqual({ mean: 0, p95: 0, max: 0, n: 0 });
  });
});
