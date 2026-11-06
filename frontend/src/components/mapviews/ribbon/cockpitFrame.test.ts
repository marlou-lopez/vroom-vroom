import { describe, expect, it } from "vitest";
import { COCKPIT_OPENING, buildCockpitFrameGeometry } from "./cockpitFrame";

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
