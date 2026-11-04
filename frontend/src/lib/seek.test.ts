import { describe, expect, it } from "vitest";
import type { XY } from "./geo";
import { seekIndexNear } from "./seek";

/** Figure-eight: one point per index, the crossing at the origin is visited at about n/4 and 3n/4. */
function eight(n: number): XY {
  const x = new Float64Array(n), y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n;
    x[i] = 100 * Math.sin(t);
    y[i] = 50 * Math.sin(2 * t);
  }
  return { x, y };
}

describe("seekIndexNear", () => {
  const line = eight(400);
  it("picks the section nearer the current index at a crossing", () => {
    const p = { x: 0, y: 0 };
    const a = seekIndexNear(line, p, 5, 5);
    const b = seekIndexNear(line, p, 5, 190);
    expect(a).toBeLessThan(20);
    expect(b).toBeGreaterThan(180);
    expect(b).toBeLessThan(220);
  });
  it("wraps around the lap", () => {
    const i = seekIndexNear(line, { x: 0, y: 0 }, 5, 395);
    expect(i === 0 || i < 10 || i > 390).toBe(true);
  });
  it("returns -1 when nothing is in range", () => {
    expect(seekIndexNear(line, { x: 1000, y: 1000 }, 5, 0)).toBe(-1);
  });
  it("breaks ties by spatial distance", () => {
    // Indices 0 and 2 are both one step from the current index 1 (which is out of range); 0 is nearer the point.
    const l: XY = { x: Float64Array.from([-5, 100, 6]), y: new Float64Array(3) };
    expect(seekIndexNear(l, { x: 0, y: 0 }, 10, 1)).toBe(0);
  });
});

describe("seekIndexNear within one stretch", () => {
  it("picks the point under the click, not the in-range point nearest the car", () => {
    // A straight line along x, 1 m per index; the click is at x = 50 with a 20 m radius, the car at index 0.
    const n = 200;
    const l: XY = { x: Float64Array.from({ length: n }, (_, i) => i), y: new Float64Array(n) };
    expect(seekIndexNear(l, { x: 50, y: 0.5 }, 20, 0)).toBe(50);
  });
});
