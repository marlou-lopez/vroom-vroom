import { describe, expect, it } from "vitest";
import { COCKPIT_OPENING } from "./cockpitFrame";
import {
  BINNACLE, BONNET_LEFT, BONNET_RIGHT, DASH_PX, DASH_REGION, DISPLAY, LEFT_POD, MIRROR, MIRROR_HOUSING, MIRROR_PX, SECOND_DISPLAY, SECOND_SHROUD, VIEW_TOP,
  GEAR_DIGIT, SHIFT_LIGHT_ROW, WHEEL_CENTRE, WHEEL_HALF, WHEEL_MARKER_SPAN, WHEEL_PLANE, WHEEL_PX, WHEEL_RIM_INNER, pxBox, rectEdges, tanMap, wheelCoverage, wheelCovers, wheelOutline, type TanRect,
} from "./cockpitLayout";

const openingTop = Math.max(...COCKPIT_OPENING.map((p) => p[1]));
const openingBottom = Math.max(...COCKPIT_OPENING.map((p) => p[1]).filter((y) => y < 0));
const inside = (inner: TanRect, outer: TanRect) => {
  const a = rectEdges(inner), b = rectEdges(outer);
  return a.x0 >= b.x0 - 1e-9 && a.x1 <= b.x1 + 1e-9 && a.y0 >= b.y0 - 1e-9 && a.y1 <= b.y1 + 1e-9;
};

describe("tan maps", () => {
  it("maps a region onto a canvas, y down", () => {
    const m = tanMap({ x0: -1, x1: 1, y0: -0.5, y1: 0.5 }, 200, 100);
    expect([m.x(-1), m.x(1), m.y(0.5), m.y(-0.5)]).toEqual([0, 200, 0, 100]);
    expect(pxBox({ cx: 0, cy: 0, w: 1, h: 0.5 }, { x0: -1, x1: 1, y0: -0.5, y1: 0.5 }, 200, 100)).toEqual({ x: 50, y: 25, w: 100, h: 50 });
  });
});

describe("cockpit layout (measured from the 1920x1080, 44 deg screenshots)", () => {
  it("puts the mirror in the roof header at the top centre, above the windscreen, within the view", () => {
    const g = rectEdges(MIRROR), h = rectEdges(MIRROR_HOUSING);
    expect(g.y0).toBeGreaterThan(openingTop);
    expect(h.y1).toBeLessThanOrEqual(VIEW_TOP + 0.002);
    expect(Math.abs(MIRROR.cx)).toBeLessThan(0.01);
    expect(inside(MIRROR, MIRROR_HOUSING)).toBe(true);
    expect(MIRROR.w / MIRROR.h).toBeCloseTo(MIRROR_PX[0] / MIRROR_PX[1], 0); // the render target has the glass's shape
  });
  it("puts both displays below the windscreen's lower edge, the second to the right, each inside its shape", () => {
    expect(rectEdges(DISPLAY).y1).toBeLessThan(openingBottom);
    expect(rectEdges(SECOND_DISPLAY).y1).toBeLessThan(openingBottom);
    expect(SECOND_DISPLAY.cx).toBeGreaterThan(DISPLAY.cx + 0.3);
    expect(inside(DISPLAY, BINNACLE)).toBe(true);
    expect(inside(SECOND_DISPLAY, SECOND_SHROUD)).toBe(true);
    expect(rectEdges(LEFT_POD).x1).toBeLessThan(rectEdges(BINNACLE).x0 + 0.05);
  });
  it("keeps the dash-top shapes inside the texture's region, which ends at the windscreen's lower edge", () => {
    expect(DASH_REGION.y1).toBeCloseTo(-0.09, 6);
    for (const r of [LEFT_POD]) expect(rectEdges(r).x0).toBeGreaterThanOrEqual(DASH_REGION.x0);
    expect(rectEdges(SECOND_SHROUD).x1).toBeLessThanOrEqual(DASH_REGION.x1);
    expect(DASH_PX[0] / DASH_PX[1]).toBeCloseTo((DASH_REGION.x1 - DASH_REGION.x0) / (DASH_REGION.y1 - DASH_REGION.y0), 1); // square pixels
  });
  it("puts the bonnet slivers on the opening's lower edge, one at each corner, thin", () => {
    for (const poly of [BONNET_LEFT, BONNET_RIGHT]) {
      expect(Math.max(...poly.map((p) => p[1]))).toBeLessThan(-0.05);
      expect(Math.min(...poly.map((p) => p[1]))).toBeGreaterThanOrEqual(openingBottom - 0.005);
    }
    expect(Math.max(...BONNET_LEFT.map((p) => p[0]))).toBeLessThan(0);
    expect(Math.min(...BONNET_RIGHT.map((p) => p[0]))).toBeGreaterThan(0.4);
  });
  it("keeps the wheel at the measured hub, with the plane's pixels square, the rim inside the plane and its top just under the display", () => {
    expect(WHEEL_CENTRE).toEqual([-0.006, -0.399]);
    expect(WHEEL_PX[0] / WHEEL_PX[1]).toBeCloseTo(WHEEL_PLANE[0] / WHEEL_PLANE[1], 2);
    expect(WHEEL_HALF[0]).toBeLessThan(WHEEL_PLANE[0] / 2);
    expect(WHEEL_HALF[1] * WHEEL_MARKER_SPAN[1]).toBeLessThan(WHEEL_PLANE[1] / 2); // the marker too
    expect(WHEEL_RIM_INNER).toBeGreaterThan(0.7);
    // The straight wheel's top is just under the display's bottom edge (-0.247): the rim's top is at -0.254.
    expect(WHEEL_CENTRE[1] + WHEEL_HALF[1]).toBeLessThanOrEqual(rectEdges(DISPLAY).y0 + 0.01);
  });
  it("draws the wheel's outline as a counter-clockwise rounded rectangle within its half sizes", () => {
    const o = wheelOutline(0.26, 0.145);
    expect(o).toHaveLength(72);
    expect(Math.max(...o.map((p) => p[0]))).toBeCloseTo(0.26, 6);
    expect(Math.max(...o.map((p) => p[1]))).toBeCloseTo(0.145, 6);
    let area = 0;
    for (let i = 0; i < o.length; i++) { const [x0, y0] = o[i], [x1, y1] = o[(i + 1) % o.length]; area += x0 * y1 - x1 * y0; }
    expect(area).toBeGreaterThan(0);
    expect(Math.abs(area / 2)).toBeGreaterThan(0.26 * 0.145 * 4 * 0.85); // fuller than an ellipse
  });
  it("lets the display show through the turned wheel: the gear digit is never covered completely, and the lights are mostly clear", () => {
    const angles = Array.from({ length: 25 }, (_, i) => -180 + 15 * i);
    const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const gear = angles.map((a) => wheelCoverage(GEAR_DIGIT, a, 64)), lights = angles.map((a) => wheelCoverage(SHIFT_LIGHT_ROW, a, 64));
    expect(Math.max(...gear)).toBeLessThan(0.6); // measured worst 0.47, at +-90 and +-165 degrees (a spoke crosses the digit)
    expect(median(gear)).toBeLessThan(0.05); // measured 0
    expect(median(lights)).toBeLessThan(0.05); // measured 0.007; the rim's side bar sweeps the row only around +-75 to +-105 degrees
    expect(wheelCoverage(GEAR_DIGIT, 0)).toBe(0); // straight ahead, the display is fully visible above the rim
    expect(wheelCoverage(SHIFT_LIGHT_ROW, 0)).toBe(0);
  });
  it("covers the rim, spokes, hub and marker, and nothing outside them", () => {
    expect(wheelCovers(0, 0, 0)).toBe(true); // hub
    expect(wheelCovers(WHEEL_HALF[0] * 0.95, 0, 0)).toBe(true); // rim, right side
    expect(wheelCovers(0.1, 0, 0)).toBe(true); // cross spoke
    expect(wheelCovers(0, -0.08, 0)).toBe(true); // lower spoke
    expect(wheelCovers(0, WHEEL_HALF[1] * 0.9, 0)).toBe(true); // marker, straddling the rim's top
    expect(wheelCovers(0, 0.08, 0)).toBe(false); // open between the spokes
    expect(wheelCovers(0.1, -0.08, 0)).toBe(false);
    // Turned 90 degrees clockwise the right side of the rim is at the bottom.
    expect(wheelCovers(0, -WHEEL_HALF[0] * 0.95, 90)).toBe(true);
    expect(wheelCovers(0, WHEEL_HALF[0] * 0.95, 90)).toBe(true);
  });
});
