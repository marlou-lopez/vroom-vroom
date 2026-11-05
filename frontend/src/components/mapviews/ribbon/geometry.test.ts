import { describe, expect, it } from "vitest";
import type { XY } from "../../../lib/geo";
import type { Kerb } from "../detailed/scene";
import { buildKerbMesh, buildLinePositions, buildRibbonMesh } from "./geometry";

const xy = (pts: [number, number][]): XY => ({ x: Float64Array.from(pts.map((p) => p[0])), y: Float64Array.from(pts.map((p) => p[1])) });
/** A straight road along east, 10 m wide (left = +5 north, right = -5). */
const road = (n: number) => ({
  left: xy(Array.from({ length: n }, (_, i) => [i, 5] as [number, number])),
  right: xy(Array.from({ length: n }, (_, i) => [i, -5] as [number, number])),
});

describe("buildRibbonMesh", () => {
  it("has two vertices per point and two triangles per segment", () => {
    const { left, right } = road(40);
    const m = buildRibbonMesh(left, right, new Float64Array(40));
    expect(m.vertexCount).toBe(80);
    expect(m.triangleCount).toBe(78);
    expect(m.indices.length).toBe(234);
  });

  it("puts each point's height on both edges (y is up, z is -north)", () => {
    const { left, right } = road(3);
    const m = buildRibbonMesh(left, right, Float64Array.from([0, 2, 4]));
    expect(Array.from(m.positions.slice(6, 12))).toEqual([1, 2, -5, 1, 2, 5]); // point 1: left (z = -5), right (z = +5)
    expect(m.positions[3 * 4 + 1]).toBe(4);
  });

  it("faces up", () => {
    const { left, right } = road(40);
    const m = buildRibbonMesh(left, right, new Float64Array(40));
    for (let t = 0; t < m.indices.length; t += 3) {
      const p = (k: number) => [m.positions[3 * m.indices[t + k]], m.positions[3 * m.indices[t + k] + 1], m.positions[3 * m.indices[t + k] + 2]];
      const [a, b, c] = [p(0), p(1), p(2)];
      const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      expect(e1[2] * e2[0] - e1[0] * e2[2]).toBeGreaterThan(0); // normal y
    }
  });

  it("adds a closing segment when the lap ends next to where it starts", () => {
    // A square loop of 4 points per side, 3 m apart: the last point is 3 m from the first.
    const pts: [number, number][] = [[0, 0], [3, 0], [6, 0], [6, 3], [6, 6], [3, 6], [0, 6], [0, 3]];
    const l = xy(pts), r = xy(pts.map(([x, y]) => [x + 1, y + 1] as [number, number]));
    const m = buildRibbonMesh(l, r, new Float64Array(8));
    expect(m.triangleCount).toBe(16); // 8 segments, the last one wrapping to point 0
    expect(Array.from(m.indices.slice(-6)).every((i) => i < 16)).toBe(true);
    expect(Array.from(m.indices.slice(-6))).toContain(0);
  });

  it("does not close an open path", () => {
    const { left, right } = road(100);
    expect(buildRibbonMesh(left, right, new Float64Array(100)).triangleCount).toBe(198);
  });
});

describe("buildLinePositions", () => {
  it("lifts each point above its height", () => {
    const p = buildLinePositions(xy([[0, 0], [1, 1]]), Float64Array.from([3, 4]), 0.1);
    expect(Array.from(p).map((v) => +v.toFixed(3))).toEqual([0, 3.1, 0, 1, 4.1, -1]);
  });
});

describe("buildKerbMesh", () => {
  const kerb: Kerb = { side: "left", xy: xy([[10, 0], [11, 0], [12, 0], [13, 0], [14, 0]]), laps: 1, start: 2 };
  const m = buildKerbMesh(kerb, Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 0.03, [1, 0, 0], [1, 1, 1]);

  it("has a quad per metre", () => {
    expect(m.vertexCount).toBe(16);
    expect(m.triangleCount).toBe(8);
  });

  it("takes the height of the centreline index it lies beside", () => {
    expect(m.positions[1]).toBeCloseTo(2.03, 5); // point 0 -> index 2
    expect(m.positions[3 * 8 + 1]).toBeCloseTo(4.03, 5); // segment 2 starts at point 2 -> index 4
  });

  it("alternates red and white stripes", () => {
    expect(Array.from(m.colors.slice(0, 3))).toEqual([1, 0, 0]);
    expect(Array.from(m.colors.slice(3 * 4 * 2, 3 * 4 * 2 + 3))).toEqual([1, 1, 1]); // segment 2 = second stripe
  });
});
