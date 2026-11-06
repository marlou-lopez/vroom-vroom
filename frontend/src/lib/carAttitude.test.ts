import { describe, expect, it } from "vitest";
import { G_SMOOTH_HALF_M, HEADING_HALF_M, K_PITCH, K_ROLL, PITCH_REST, attitudeAt, estimateAttitude } from "./carAttitude";

const N = 200;
const line = (f: (i: number) => [number, number]) => {
  const x = new Float64Array(N), y = new Float64Array(N);
  for (let i = 0; i < N; i++) [x[i], y[i]] = f(i);
  return { x, y };
};
const flat = new Float64Array(N);
const zeros = new Array(N).fill(0);
const filled = (v: number) => new Array(N).fill(v);

describe("estimateAttitude", () => {
  it("heading is the direction of travel: 0 = east, pi/2 = north", () => {
    const east = estimateAttitude({ line: line((i) => [i, 0]), heights: flat, gLat: zeros, gLong: zeros });
    const north = estimateAttitude({ line: line((i) => [0, i]), heights: flat, gLat: zeros, gLong: zeros });
    expect(east.heading[100]).toBeCloseTo(0);
    expect(north.heading[100]).toBeCloseTo(Math.PI / 2);
    expect(estimateAttitude({ line: line((i) => [-i, 0]), heights: flat, gLat: zeros, gLong: zeros }).heading[100]).toBeCloseTo(Math.PI);
  });

  it("heading turns left (increases) on a left-hand arc", () => {
    const r = 100; // anticlockwise circle seen from above = left turns
    const a = estimateAttitude({ line: line((i) => [r * Math.sin(i / r), r * (1 - Math.cos(i / r))]), heights: flat, gLat: zeros, gLong: zeros });
    expect(a.heading[150] - a.heading[50]).toBeGreaterThan(0.9); // 100 m of a 100 m radius arc = 1 rad
    expect(a.heading[150] - a.heading[50]).toBeCloseTo(1, 1);
  });

  it("slope pitches the nose up when the road climbs, down when it falls", () => {
    const up = new Float64Array(N).map((_, i) => i * 0.1);
    const down = new Float64Array(N).map((_, i) => -i * 0.1);
    const l = line((i) => [i, 0]);
    expect(estimateAttitude({ line: l, heights: up, gLat: zeros, gLong: zeros }).slope[100]).toBeCloseTo(Math.atan(0.1));
    expect(estimateAttitude({ line: l, heights: down, gLat: zeros, gLong: zeros }).slope[100]).toBeCloseTo(-Math.atan(0.1));
  });

  it("braking (g_long > 0) dives the nose and accelerating (g_long < 0) lifts it, relative to the rest attitude", () => {
    const l = line((i) => [i, 0]);
    const brake = estimateAttitude({ line: l, heights: flat, gLat: zeros, gLong: filled(1.5) });
    const accel = estimateAttitude({ line: l, heights: flat, gLat: zeros, gLong: filled(-1) });
    const coast = estimateAttitude({ line: l, heights: flat, gLat: zeros, gLong: zeros });
    expect(brake.dive[100]).toBeLessThan(coast.dive[100]);
    expect(accel.dive[100]).toBeGreaterThan(coast.dive[100]);
    expect(coast.dive[100]).toBeCloseTo(PITCH_REST);
    expect(brake.dive[100]).toBeCloseTo(PITCH_REST + K_PITCH * 1.5);
    expect(brake.pitch[100]).toBeCloseTo(brake.slope[100] + brake.dive[100]);
  });

  it("roll follows lateral g with the fitted gain and sign, and the road bank adds to it", () => {
    const l = line((i) => [i, 0]);
    const left = estimateAttitude({ line: l, heights: flat, gLat: filled(2), gLong: zeros });
    expect(left.roll[100]).toBeCloseTo(K_ROLL * 2);
    const banked = estimateAttitude({ line: l, heights: flat, gLat: filled(2), gLong: zeros, bank: filled(0.05) });
    expect(banked.roll[100]).toBeCloseTo(K_ROLL * 2 + 0.05);
    expect(estimateAttitude({ line: l, heights: flat, gLat: zeros, gLong: zeros }).roll[100]).toBeCloseTo(0);
    // Unknown bank (null, NaN) counts as flat, and a left turn rolls the body outward (to the right): the physical sign.
    const unknown = estimateAttitude({ line: l, heights: flat, gLat: filled(2), gLong: zeros, bank: filled(0).map((_, i) => (i % 2 ? null : NaN)) });
    expect(unknown.roll[100]).toBeCloseTo(K_ROLL * 2);
    expect(K_ROLL).toBeGreaterThan(0);
  });

  it("smooths vibration out of the g channels and ignores NaN", () => {
    const l = line((i) => [i, 0]);
    const noisy = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 3 : -3));
    const a = estimateAttitude({ line: l, heights: flat, gLat: noisy, gLong: zeros });
    expect(Math.abs(a.roll[100])).toBeLessThan(Math.abs(K_ROLL) * 3 / (G_SMOOTH_HALF_M / 2));
    const withNaN = filled(1);
    withNaN[100] = NaN;
    expect(Number.isFinite(estimateAttitude({ line: l, heights: flat, gLat: withNaN, gLong: zeros }).roll[100])).toBe(true);
  });

  it("clamps the heading chord at the ends of the lap and is as long as the shortest channel", () => {
    const a = estimateAttitude({ line: line((i) => [i, 0]), heights: flat, gLat: zeros.slice(0, 150), gLong: zeros });
    expect(a.heading.length).toBe(150);
    expect(a.heading[0]).toBeCloseTo(0);
    expect(a.heading[149]).toBeCloseTo(0);
    expect(HEADING_HALF_M).toBeGreaterThan(0);
  });
});

describe("attitudeAt", () => {
  const a = estimateAttitude({ line: line((i) => [i, 0]), heights: flat, gLat: Array.from({ length: N }, (_, i) => i / 100), gLong: zeros });
  it("interpolates between metres", () => {
    const lo = attitudeAt(a, 100).roll, hi = attitudeAt(a, 101).roll;
    expect(attitudeAt(a, 100.5).roll).toBeCloseTo((lo + hi) / 2);
  });
  it("clamps outside the lap", () => {
    expect(attitudeAt(a, -5).roll).toBe(a.roll[0]);
    expect(attitudeAt(a, 1e6).roll).toBe(a.roll[N - 1]);
  });
  it("takes the short way round across the +-pi seam", () => {
    const seam = { ...a, heading: Float64Array.from([Math.PI - 0.05, -Math.PI + 0.05]), slope: new Float64Array(2), dive: new Float64Array(2), roll: new Float64Array(2), pitch: new Float64Array(2) };
    const h = attitudeAt(seam, 0.5).heading;
    expect(Math.abs(Math.abs(h) - Math.PI)).toBeLessThan(1e-9);
  });
  it("is zero for an empty lap", () => {
    const empty = estimateAttitude({ line: { x: new Float64Array(0), y: new Float64Array(0) }, heights: flat, gLat: [], gLong: [] });
    expect(attitudeAt(empty, 3)).toEqual({ heading: 0, slope: 0, dive: 0, roll: 0 });
  });
});
