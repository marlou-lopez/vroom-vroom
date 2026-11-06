import { describe, expect, it } from "vitest";
import type { XY } from "../../../lib/geo";
import type { Kerb } from "../detailed/scene";
import { KERB_W_M } from "../detailed/renderer";
import { VERGE_BAND_M, VERGE_DROP_M, VERGE_ROWS_M, buildKerbMesh, buildLinePositions, buildRibbonMesh, buildVergeMesh } from "./geometry";

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

  it("is KERB_W_M wide, or kerb.width wide when the kerb has one", () => {
    const wide = buildKerbMesh({ ...kerb, width: 2 }, Float64Array.from([0, 1, 2, 3, 4, 5, 6, 7]), 0, [1, 0, 0], [1, 1, 1]);
    const span = (mm: { positions: Float32Array }) => Math.abs(mm.positions[2] - mm.positions[5]);
    expect(span(wide)).toBeCloseTo(2, 5);
    expect(span(m)).toBeCloseTo(KERB_W_M, 5);
  });

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

describe("buildVergeMesh", () => {
  const n = 60;
  const centre = xy(Array.from({ length: n }, (_, i) => [i, 0] as [number, number]));
  const leftEdge = xy(Array.from({ length: n }, (_, i) => [i, 5] as [number, number]));
  const heights = Float64Array.from({ length: n }, (_, i) => i * 0.5);
  const grass: [number, number, number] = [0, 1, 0], alt: [number, number, number] = [0, 0.5, 0], haze: [number, number, number] = [0.5, 0.5, 1];
  const m = buildVergeMesh(leftEdge, centre, heights, grass, alt, haze);

  it("has three rows of vertices per grid index and two triangles per row gap per metre", () => {
    expect(m.vertexCount).toBe(n * VERGE_ROWS_M.length);
    expect(m.triangleCount).toBe((n - 1) * (VERGE_ROWS_M.length - 1) * 2);
    expect(m.indices.length).toBe(m.triangleCount * 3);
  });

  it("runs outward from the track edge, away from the centreline, at the road height minus the drop (three.js axes)", () => {
    const rows = VERGE_ROWS_M.length;
    for (let r = 0; r < rows; r++) {
      const v = 10 * rows + r;
      expect(m.positions[3 * v]).toBeCloseTo(10); // east
      expect(m.positions[3 * v + 1]).toBeCloseTo(5 - VERGE_DROP_M); // road height 5 m at index 10
      expect(m.positions[3 * v + 2]).toBeCloseTo(-(5 + VERGE_ROWS_M[r])); // three z = -north, the left edge is north of the centre
    }
  });

  it("goes the other way on the other side", () => {
    const rightEdge = xy(Array.from({ length: n }, (_, i) => [i, -5] as [number, number]));
    const r = buildVergeMesh(rightEdge, centre, heights, grass, alt, haze);
    expect(r.positions[3 * (10 * VERGE_ROWS_M.length + 2) + 2]).toBeCloseTo(5 + VERGE_ROWS_M[2]);
  });

  it("alternates the grass colour in bands and ends in haze", () => {
    const rows = VERGE_ROWS_M.length;
    const col = (i: number, r: number) => Array.from(m.colors.slice(3 * (i * rows + r), 3 * (i * rows + r) + 3));
    expect(col(0, 0)).toEqual(grass);
    expect(col(VERGE_BAND_M, 1)).toEqual(alt);
    expect(col(2 * VERGE_BAND_M, 0)).toEqual(grass);
    expect(col(5, rows - 1)).toEqual(haze);
  });

  it("is empty for an empty track and keeps the previous direction where the edge meets the centre", () => {
    const e = buildVergeMesh(xy([]), xy([]), new Float64Array(0), grass, alt, haze);
    expect(e.vertexCount).toBe(0);
    expect(e.indices.length).toBe(0);
    const pinch = xy(Array.from({ length: 4 }, (_, i) => [i, i === 2 ? 0 : 5] as [number, number]));
    const p = buildVergeMesh(pinch, xy(Array.from({ length: 4 }, (_, i) => [i, 0] as [number, number])), new Float64Array(4), grass, alt, haze);
    expect(p.positions.every(Number.isFinite)).toBe(true);
  });
});
