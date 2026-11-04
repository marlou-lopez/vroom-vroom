import { describe, expect, it } from "vitest";
import {
  FOLLOW_WIDTH_M, MIN_WIDTH_M, fitBounds, followCamera, panBy, screenToWorld, smoothHeading, worldToScreen, zoomAt, zoomScale,
  type Camera, type Viewport,
} from "./camera";

const v: Viewport = { w: 800, h: 600 };
const limits = { minM: MIN_WIDTH_M, maxM: 5000 };

describe("worldToScreen / screenToWorld", () => {
  for (const rotation of [0, 1.1]) {
    it(`round-trips at rotation ${rotation}`, () => {
      const c: Camera = { cx: 120, cy: -40, widthM: 300, rotation };
      const p = { x: 77.5, y: 13.25 };
      const q = screenToWorld(c, v, worldToScreen(c, v, p));
      expect(q.x).toBeCloseTo(p.x, 9);
      expect(q.y).toBeCloseTo(p.y, 9);
    });
  }
  it("maps the camera centre to the viewport centre", () => {
    const c: Camera = { cx: 5, cy: 6, widthM: 100, rotation: 0.4 };
    const s = worldToScreen(c, v, { x: 5, y: 6 });
    expect(s.x).toBeCloseTo(400, 9);
    expect(s.y).toBeCloseTo(300, 9);
  });
  it("draws north up and east right at rotation 0", () => {
    const c: Camera = { cx: 0, cy: 0, widthM: 800, rotation: 0 };
    const s = worldToScreen(c, v, { x: 10, y: 10 });
    expect(s.x).toBeCloseTo(410, 9);
    expect(s.y).toBeCloseTo(290, 9);
  });
});

describe("zoomAt", () => {
  it("keeps the point under the cursor fixed", () => {
    const c: Camera = { cx: 10, cy: 20, widthM: 400, rotation: 0.7 };
    const cursor = { x: 600, y: 120 };
    const before = screenToWorld(c, v, cursor);
    const n = zoomAt(c, v, cursor, 0.5, limits);
    expect(n.widthM).toBeCloseTo(200, 9);
    const after = screenToWorld(n, v, cursor);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });
  it("clamps to the limits", () => {
    const c: Camera = { cx: 0, cy: 0, widthM: 30, rotation: 0 };
    expect(zoomAt(c, v, { x: 10, y: 10 }, 0.01, limits).widthM).toBe(MIN_WIDTH_M);
    expect(zoomAt(c, v, { x: 10, y: 10 }, 1e6, limits).widthM).toBe(5000);
  });
  it("keeps the centre across viewport sizes", () => {
    const c = fitBounds({ minX: 0, maxX: 100, minY: 0, maxY: 50 }, v);
    const n = zoomAt(c, { w: 400, h: 300 }, { x: 200, y: 150 }, 1, limits);
    expect(n.cx).toBeCloseTo(c.cx, 9);
    expect(n.cy).toBeCloseTo(c.cy, 9);
  });
});

describe("panBy", () => {
  it("moves content with the pointer", () => {
    const c: Camera = { cx: 0, cy: 0, widthM: 800, rotation: 0 };
    const p = { x: 30, y: 30 };
    const before = worldToScreen(c, v, p);
    const after = worldToScreen(panBy(c, v, 25, -10), v, p);
    expect(after.x - before.x).toBeCloseTo(25, 9);
    expect(after.y - before.y).toBeCloseTo(-10, 9);
  });
  it("respects rotation", () => {
    const c: Camera = { cx: 3, cy: 4, widthM: 200, rotation: 1.1 };
    const p = { x: 30, y: -12 };
    const before = worldToScreen(c, v, p);
    const after = worldToScreen(panBy(c, v, 40, 15), v, p);
    expect(after.x - before.x).toBeCloseTo(40, 9);
    expect(after.y - before.y).toBeCloseTo(15, 9);
  });
});

describe("fitBounds", () => {
  for (const vp of [{ w: 400, h: 300 }, { w: 300, h: 400 }]) {
    it(`contains all corners in ${vp.w}x${vp.h}`, () => {
      const b = { minX: -500, maxX: 700, minY: -100, maxY: 300 };
      const c = fitBounds(b, vp, 16);
      expect(c.rotation).toBe(0);
      for (const x of [b.minX, b.maxX]) for (const y of [b.minY, b.maxY]) {
        const s = worldToScreen(c, vp, { x, y });
        expect(s.x).toBeGreaterThanOrEqual(16 - 1e-9);
        expect(s.x).toBeLessThanOrEqual(vp.w - 16 + 1e-9);
        expect(s.y).toBeGreaterThanOrEqual(16 - 1e-9);
        expect(s.y).toBeLessThanOrEqual(vp.h - 16 + 1e-9);
      }
    });
  }
  it("survives zero spans and tiny viewports", () => {
    const c = fitBounds({ minX: 1, maxX: 1, minY: 2, maxY: 2 }, { w: 10, h: 10 });
    expect(Number.isFinite(c.widthM) && c.widthM > 0).toBe(true);
  });
});

describe("followCamera", () => {
  it("puts a point ahead of a due-east car straight above centre when heading-up", () => {
    const car = { x: 100, y: 50 };
    const c = followCamera(car, 0, FOLLOW_WIDTH_M, true);
    const s = worldToScreen(c, v, { x: car.x + 10, y: car.y });
    expect(s.x).toBeCloseTo(v.w / 2, 9);
    expect(s.y).toBeLessThan(v.h / 2);
  });
  it("does not rotate when north-up", () => {
    expect(followCamera({ x: 0, y: 0 }, 1, 150, false).rotation).toBe(0);
  });
});

describe("smoothHeading", () => {
  it("blends along the shortest arc across +-pi", () => {
    expect(Math.abs(smoothHeading(3.1, -3.1, 0.5))).toBeGreaterThan(3.1);
  });
  it("alpha 1 gives next, alpha 0 gives prev", () => {
    expect(smoothHeading(0.4, -2, 1)).toBeCloseTo(-2, 9);
    expect(smoothHeading(0.4, -2, 0)).toBeCloseTo(0.4, 9);
  });
  it("blends plainly away from the wrap", () => {
    expect(smoothHeading(0.1, 0.3, 0.5)).toBeCloseTo(0.2, 9);
  });
  it("normalises to (-pi, pi]", () => {
    const r = smoothHeading(3, -3, 1);
    expect(r).toBeGreaterThan(-Math.PI);
    expect(r).toBeLessThanOrEqual(Math.PI);
  });
});

describe("zoomScale", () => {
  it("is 1 when the view is 300 m wide or more", () => {
    expect(zoomScale(300)).toBe(1);
    expect(zoomScale(7000)).toBe(1);
  });
  it("reaches the maximum at 20 m and stays there", () => {
    expect(zoomScale(20)).toBeCloseTo(1.8, 10);
    expect(zoomScale(5)).toBeCloseTo(1.8, 10);
  });
  it("grows smoothly in between (log scale)", () => {
    expect(zoomScale(Math.sqrt(300 * 20))).toBeCloseTo(1.4, 10); // geometric midpoint ≈ 77 m
    expect(zoomScale(150)).toBeGreaterThan(1);
    expect(zoomScale(150)).toBeLessThan(zoomScale(50));
  });
});
