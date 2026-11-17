import { describe, expect, it } from "vitest";
import type { Corner } from "../types";
import { cornerChange, cornerComparison, cornerSide } from "./coachFacts";

const N = 1000;
const fill = (v: number) => new Array<number>(N).fill(v);
/** A synthetic lap: 0.05 s per metre, 100 km/h, no pedals, with `edit` applied. */
function lap(edit: (a: { throttle: number[]; brake: number[]; speed_kmh: number[]; steering: number[] }) => void) {
  const a = { t: Array.from({ length: N }, (_, i) => i * 0.05), speed_kmh: fill(100), throttle: fill(0), brake: fill(0), steering: fill(0) };
  edit(a);
  return a;
}
const corner = (start_m: number, apex_m: number, end_m: number): Corner => ({
  id: "c", name: "C", start_m, apex_m, end_m, complex: null, approx: false,
});
const range = (a: number[], from: number, to: number, v: number) => { for (let i = from; i < to; i++) a[i] = v; };

describe("coasting and overlap", () => {
  it("counts seconds with neither pedal above 50 km/h, and only inside the corner", () => {
    const c = cornerSide(lap((a) => {
      range(a.throttle, 0, N, 1);
      range(a.throttle, 120, 140, 0); // 20 m coasting
      range(a.throttle, 300, 320, 0); // outside the corner
      range(a.throttle, 150, 160, 0); range(a.speed_kmh, 150, 160, 40); // slow: not coasting
      range(a.throttle, 170, 175, 0); range(a.brake, 170, 175, 0.04); // brake < 0.05 still coasting
    }), corner(100, 150, 200));
    expect(c.coastS).toBeCloseTo((20 + 5) * 0.05, 9);
    expect(c.overlapS).toBe(0);
  });

  it("counts seconds with both pedals above 0.1", () => {
    const c = cornerSide(lap((a) => {
      range(a.throttle, 110, 130, 0.5); range(a.brake, 120, 140, 0.5); // overlap 120..130
      range(a.throttle, 150, 160, 0.1); range(a.brake, 150, 160, 0.5); // throttle not > 0.1
    }), corner(100, 150, 200));
    expect(c.overlapS).toBeCloseTo(10 * 0.05, 9);
  });

  it("handles a corner that wraps over the start line", () => {
    const c = cornerSide(lap((a) => {
      range(a.throttle, 0, N, 1);
      range(a.throttle, 980, 990, 0); // coasting before the line
      range(a.throttle, 5, 15, 0); // coasting after it
      range(a.brake, 990, 995, 0.5); range(a.throttle, 990, 995, 0.5); // overlap before the line
      range(a.throttle, 2, 4, 0.5); range(a.brake, 2, 4, 0.5); // overlap after it
      range(a.throttle, 400, 410, 0); // far from the corner
      range(a.speed_kmh, 0, 20, 60); a.speed_kmh[1] = 55; // minimum just after the line
    }), corner(970, 995, 30));
    expect(c.coastS).toBeCloseTo(20 * 0.05, 9);
    expect(c.overlapS).toBeCloseTo(7 * 0.05, 9);
    expect(c.minIdx).toBe(1);
    expect(c.exitSpeed).toBe(100);
  });

  it("finds the brake onset and pickup across the line", () => {
    const c = cornerSide(lap((a) => {
      range(a.brake, 985, 999, 0.8);
      range(a.throttle, 10, 30, 1);
      range(a.speed_kmh, 0, 6, 70); a.speed_kmh[5] = 60;
    }), corner(970, 998, 40));
    expect(c.brakeOnset).toBe(985);
    expect(c.peakBrake).toBe(0.8);
    expect(c.minIdx).toBe(5);
    expect(c.throttlePickup).toBe(10);
  });

  it("wrapping delta is the change across the line", () => {
    const delta = Array.from({ length: N }, (_, i) => i * 0.001);
    expect(cornerChange(delta, corner(100, 120, 200))).toBeCloseTo(0.1, 9);
    expect(cornerChange(delta, corner(990, 0, 10))).toBeCloseTo(0.009 + 0.01, 9);
  });
});

describe("CornerMetrics from cornerComparison", () => {
  it("uses the contract's field names and rounds", () => {
    const l = lap((a) => { range(a.brake, 110, 140, 0.8); range(a.speed_kmh, 140, 150, 80.04); });
    const r = lap((a) => { range(a.brake, 120, 140, 0.6); });
    const delta = Array.from({ length: N }, (_, i) => (i > 100 ? 0.12345 : 0));
    const m = cornerComparison(corner(100, 150, 200), l, r, delta, []).metrics;
    expect(m.corner_id).toBe("c");
    expect(m.delta_s).toBe(0.123);
    expect(m.lap).toMatchObject({ brake_onset_m: 110, peak_brake: 0.8, min_speed_kmh: 80, min_speed_m: 140, throttle_pickup_m: null, exit_speed_kmh: 100 });
    expect(m.ref.brake_onset_m).toBe(120);
  });
});
