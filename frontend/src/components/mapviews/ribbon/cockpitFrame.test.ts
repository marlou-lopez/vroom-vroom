import { describe, expect, it } from "vitest";
import { COCKPIT_OPENING, SIDE_WINDOW, buildCockpitFrameGeometry, buildOpeningEdgeGeometry } from "./cockpitFrame";

/** Whether the view direction (tx, ty) falls on a triangle of the frame. */
function covered(tx: number, ty: number, d: number): boolean {
  const g = buildCockpitFrameGeometry(d);
  const p = g.getAttribute("position");
  const idx = g.getIndex()!;
  const x = tx * d, y = ty * d;
  for (let i = 0; i < idx.count; i += 3) {
    const [a, b, c] = [0, 1, 2].map((k) => idx.getX(i + k));
    const e1 = (x - p.getX(b)) * (p.getY(a) - p.getY(b)) - (p.getX(a) - p.getX(b)) * (y - p.getY(b));
    const e2 = (x - p.getX(c)) * (p.getY(b) - p.getY(c)) - (p.getX(b) - p.getX(c)) * (y - p.getY(c));
    const e3 = (x - p.getX(a)) * (p.getY(c) - p.getY(a)) - (p.getX(c) - p.getX(a)) * (y - p.getY(a));
    if ((e1 >= 0 && e2 >= 0 && e3 >= 0) || (e1 <= 0 && e2 <= 0 && e3 <= 0)) return true;
  }
  return false;
}

describe("cockpit frame", () => {
  it("has 13 opening vertices", () => expect(COCKPIT_OPENING).toHaveLength(13));
  it("leaves the opening clear", () => {
    expect(covered(0, 0, 0.15)).toBe(false);
    expect(covered(0.7, 0, 0.15)).toBe(false);
    expect(covered(2, 0, 0.15)).toBe(false);
  });
  it("covers the roof, the dashboard and the left pillar", () => {
    expect(covered(0, 0.3, 0.15)).toBe(true);
    expect(covered(0, -0.2, 0.15)).toBe(true);
    expect(covered(-0.6, 0, 0.15)).toBe(true);
  });
  it("sits at the requested depth", () => {
    const p = buildCockpitFrameGeometry(0.2).getAttribute("position");
    for (let i = 0; i < p.count; i++) expect(p.getZ(i)).toBeCloseTo(-0.2);
  });
});

describe("left side window", () => {
  it("is open just left of the A-pillar, inside the window", () => {
    expect(covered(-0.7, -0.01, 0.15)).toBe(false); // the measured sliver (apex at -0.679, 0.0135 below the axis)
    expect(covered(-0.7, 0.0, 0.15)).toBe(false);
    expect(covered(-0.9, 0.0, 0.15)).toBe(false); // the designed extension, seen in a wider window
    expect(covered(-1.2, 0.05, 0.15)).toBe(false);
  });
  it("is covered by the pillar itself, the sill, the roof and beyond the rear edge", () => {
    expect(covered(-0.6, 0.0, 0.15)).toBe(true); // the A-pillar, between the two openings
    expect(covered(-0.66, -0.0135, 0.15)).toBe(true); // just right of the apex
    expect(covered(-0.9, -0.15, 0.15)).toBe(true); // below the sill
    expect(covered(-0.9, 0.3, 0.15)).toBe(true); // the roof
    expect(covered(-0.7, 0.1, 0.15)).toBe(true); // above the cage tube's edge near the pillar
    expect(covered(-1.4, 0.0, 0.15)).toBe(true); // behind the rear edge
  });
  it("lies left of the windscreen opening and does not touch it", () => {
    const wsLeft = Math.min(...COCKPIT_OPENING.map((p) => p[0]));
    expect(Math.max(...SIDE_WINDOW.map((p) => p[0]))).toBeLessThan(wsLeft - 0.1);
  });
  it("can be left out", () => {
    const g = buildCockpitFrameGeometry(0.15, COCKPIT_OPENING, []);
    expect(g.getIndex()!.count).toBeLessThan(buildCockpitFrameGeometry(0.15).getIndex()!.count);
  });
});

describe("opening edge", () => {
  const g = buildOpeningEdgeGeometry(1, COCKPIT_OPENING, 0.01);
  const p = g.getAttribute("position");
  it("has an inner and an outer vertex per opening point, at the frame's depth", () => {
    expect(p.count).toBe(COCKPIT_OPENING.length * 2);
    for (let i = 0; i < p.count; i++) expect(p.getZ(i)).toBeCloseTo(-1);
    expect(g.getIndex()!.count).toBe(COCKPIT_OPENING.length * 6);
  });
  it("starts on the opening and moves outward (into the frame), by the width, with the colour fading to nothing", () => {
    COCKPIT_OPENING.forEach(([x, y], i) => {
      expect(p.getX(2 * i)).toBeCloseTo(x);
      expect(p.getY(2 * i)).toBeCloseTo(y);
      const dx = p.getX(2 * i + 1) - x, dy = p.getY(2 * i + 1) - y;
      expect(Math.hypot(dx, dy)).toBeCloseTo(0.01, 6);
    });
    // The first opening point is the top left corner: outward is up. A bottom-edge point's outward is down.
    expect(p.getY(1)).toBeGreaterThan(p.getY(0));
    const bottom = COCKPIT_OPENING.findIndex((q) => q[0] === 0.1047);
    expect(p.getY(2 * bottom + 1)).toBeLessThan(p.getY(2 * bottom));
    const c = g.getAttribute("color");
    expect(c.getW(0)).toBeCloseTo(0.55, 6);
    expect(c.getW(1)).toBe(0);
  });
});
