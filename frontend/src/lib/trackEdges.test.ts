import { describe, expect, it } from "vitest";
import { edgeHalfWidths, edgeLines, kerbRuns, type EdgeLap } from "./trackEdges";

const filled = (n: number, v: number) => new Array<number>(n).fill(v);
const mk = (pl: number[], te: number[], kerb?: number[]): EdgeLap => ({ pathLateral: pl, trackEdge: te, kerb: kerb ?? filled(pl.length, 0) });

describe("edgeHalfWidths", () => {
  it("a lap fully on the left measures only the left; the right takes the fallback", () => {
    const e = edgeHalfWidths([mk(filled(50, -2), filled(50, -5))], 50);
    expect(Array.from(e.left)).toEqual(filled(50, 5));
    expect(Array.from(e.right)).toEqual(filled(50, 7));
    expect(e.leftMeasured.every((v) => v === 1)).toBe(true);
    expect(e.rightMeasured.every((v) => v === 0)).toBe(true);
  });

  it("drops indices within 6 m of a left-to-right flip", () => {
    const n = 60;
    const pl = Array.from({ length: n }, (_, i) => (i < 30 ? -2 : 2));
    const te = Array.from({ length: n }, (_, i) => (i < 30 ? -5 : 6));
    const e = edgeHalfWidths([mk(pl, te)], n);
    for (let i = 0; i < n; i++) {
      const nearFlip = i >= 24 && i <= 35;
      if (i < 30) expect(e.leftMeasured[i]).toBe(nearFlip ? 0 : 1);
      else expect(e.rightMeasured[i]).toBe(nearFlip ? 0 : 1);
    }
  });

  it("the median of three laps ignores an outlier", () => {
    const lap = (v: number) => mk(filled(20, 1), filled(20, v));
    const e = edgeHalfWidths([lap(5), lap(5.2), lap(40)], 20);
    expect(e.right[10]).toBeCloseTo(5.2, 9);
  });

  it("ignores off-track points (|pathLateral| > 15)", () => {
    const pl = filled(40, 1);
    for (let i = 10; i < 20; i++) pl[i] = 20;
    const e = edgeHalfWidths([mk(pl, filled(40, 5))], 40);
    for (let i = 10; i < 20; i++) expect(e.rightMeasured[i]).toBe(0);
    // the sign guard also drops the 6 m on either side of the off-track stretch
    expect(e.rightMeasured[3]).toBe(1);
    expect(e.rightMeasured[30]).toBe(1);
    expect(e.rightMeasured[8]).toBe(0);
  });

  it("fills gaps linearly, including across the start/finish wrap", () => {
    const n = 100;
    const te = filled(n, 0);
    // measured at 20..79 as 4 (at 20..49) and 8 (50..79); 80..99 and 0..19 unmeasured
    for (let i = 20; i < 80; i++) te[i] = i < 50 ? 4 : 8;
    const pl = te.map((v) => (v === 0 ? 0 : 1));
    const e = edgeHalfWidths([mk(pl, te)], n);
    // wrap gap: from index 79 (value ~8) to index 20 (value ~4), 41 steps
    const a = e.right[79], b = e.right[20];
    expect(e.rightMeasured[90]).toBe(0);
    const t = (idx: number) => ((idx - 79 + n) % n) / 41;
    for (const idx of [80, 99, 0, 19]) expect(e.right[idx]).toBeCloseTo(a + (b - a) * t(idx), 9);
  });

  it("smoothing ignores unmeasured neighbours", () => {
    const n = 40;
    const te = Array.from({ length: n }, (_, i) => i + 1);
    const pl = filled(n, 1);
    for (let i = 20; i < 30; i++) pl[i] = 20; // off track: 14..35 end up unmeasured (guard)
    const e = edgeHalfWidths([mk(pl, te)], n);
    expect(e.rightMeasured[13]).toBe(1);
    expect(e.rightMeasured[14]).toBe(0);
    // index 13 averages 10..13 only (values 11..14 -> 12.5); counting 14..16 as 0 would give a lower value
    expect(e.right[13]).toBeCloseTo(12.5, 9);
  });
});

describe("kerbRuns", () => {
  const run = (n: number, ranges: [number, number][], side: 1 | -1): EdgeLap => {
    const kerb = filled(n, 0);
    for (const [a, b] of ranges) for (let i = a; i <= b; i++) kerb[i] = 1;
    return mk(filled(n, side * 2), filled(n, side * 5), kerb);
  };

  it("takes the side from path_lateral, merges gaps <= 5 and drops runs < 3 m", () => {
    const l = run(100, [[10, 20], [26, 30], [50, 51], [70, 72]], -1);
    expect(kerbRuns([l], 100)).toEqual([
      { side: "left", start: 10, end: 30, laps: 1 },
      { side: "left", start: 70, end: 72, laps: 1 },
    ]);
    const r = run(100, [[10, 20], [27, 30]], 1); // gap of 6 is not merged
    expect(kerbRuns([r], 100).map((k) => [k.side, k.start, k.end])).toEqual([["right", 10, 20], ["right", 27, 30]]);
  });

  it("counts distinct laps inside a run and ignores off-track points", () => {
    const a = run(60, [[10, 20]], 1);
    const b = run(60, [[18, 30]], 1);
    const off = run(60, [[40, 50]], 1);
    for (let i = 40; i <= 50; i++) (off.pathLateral as number[])[i] = 25;
    const runs = kerbRuns([a, b, off], 60);
    expect(runs).toEqual([{ side: "right", start: 10, end: 30, laps: 2 }]);
  });
});

describe("edgeLines", () => {
  it("on an eastbound centreline, left is +y and right is -y", () => {
    const n = 5;
    const centre = { x: Float64Array.from([0, 1, 2, 3, 4]), y: new Float64Array(n) };
    const nLeft = { x: new Float64Array(n), y: new Float64Array(n).fill(1) };
    const e = { left: new Float64Array(n).fill(4), right: new Float64Array(n).fill(6), leftMeasured: new Uint8Array(n), rightMeasured: new Uint8Array(n) };
    const [l, r] = edgeLines(centre, nLeft, e);
    expect(Array.from(l.y)).toEqual(filled(n, 4));
    expect(Array.from(r.y)).toEqual(filled(n, -6));
    expect(Array.from(l.x)).toEqual(Array.from(centre.x));
  });
});
