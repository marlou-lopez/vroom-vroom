import { describe, expect, it } from "vitest";
import type { XY } from "../../../lib/geo";
import { aheadPoint, carEuler, carPose } from "./pose";

/** A line along east, 1 m per point. */
const east = (n: number): XY => ({ x: Float64Array.from({ length: n }, (_, i) => i), y: new Float64Array(n) });
const ramp = (n: number, slope: number) => Float64Array.from({ length: n }, (_, i) => i * slope);

describe("carPose", () => {
  const line = east(100);

  it("sits at the line's point, at the road height, with the given heading", () => {
    const p = carPose(line, ramp(100, 0.1), 40.5, 0.3);
    expect(p.east).toBeCloseTo(40.5);
    expect(p.north).toBeCloseTo(0);
    expect(p.height).toBeCloseTo(4.05);
    expect(p.heading).toBe(0.3);
  });

  it("pitches nose-up uphill, nose-down downhill and flat on the level", () => {
    expect(carPose(line, ramp(100, 0.1), 50, 0).pitch).toBeCloseTo(Math.atan(0.1), 6);
    expect(carPose(line, ramp(100, -0.1), 50, 0).pitch).toBeCloseTo(-Math.atan(0.1), 6);
    expect(carPose(line, new Float64Array(100), 50, 0).pitch).toBe(0);
  });

  it("the exaggeration steepens the pitch to match the exaggerated surface", () => {
    expect(carPose(line, ramp(100, 0.1), 50, 0, 3).pitch).toBeCloseTo(Math.atan(0.3), 6);
  });

  it("measures the slope along the car's own line (a longer path for the same rise is gentler)", () => {
    const diag: XY = { x: Float64Array.from({ length: 100 }, (_, i) => i * 0.6), y: Float64Array.from({ length: 100 }, (_, i) => i * 0.8) };
    // 1 m of grid index is 1 m along the line here; rise 0.1 m per index
    expect(carPose(diag, ramp(100, 0.1), 50, 0).pitch).toBeCloseTo(Math.atan(0.1), 6);
  });

  it("copes with the ends of the line", () => {
    expect(Number.isFinite(carPose(line, ramp(100, 0.1), 0, 0).pitch)).toBe(true);
    expect(carPose(line, ramp(100, 0.1), 99, 0).pitch).toBeGreaterThan(0);
  });
});

describe("aheadPoint", () => {
  it("is further along the line, with its height", () => {
    const a = aheadPoint(east(100), ramp(100, 0.5), 10, 30);
    expect(a.east).toBeCloseTo(40);
    expect(a.height).toBeCloseTo(20);
  });
});

describe("carEuler", () => {
  it("nose-up pitch is a negative rotation about x for a model whose nose is +z", () => {
    expect(carEuler({ heading: 0, pitch: 0.2 }).x).toBeCloseTo(-0.2);
  });

  it("yaw turns the nose (+z) onto the heading in three.js axes", () => {
    for (const heading of [0, Math.PI / 2, 1, -2]) {
      const yaw = carEuler({ heading, pitch: 0 }).y;
      // Rotation about y by yaw takes +z to (sin yaw, 0, cos yaw); the heading's direction is (cos h, 0, -sin h).
      expect(Math.sin(yaw)).toBeCloseTo(Math.cos(heading), 9);
      expect(Math.cos(yaw)).toBeCloseTo(-Math.sin(heading), 9);
    }
  });
});
