import { describe, expect, it } from "vitest";
import { chipFraction, chipLayerGeometry, clipBand, stripRanges, valueToPx, withAlpha } from "./strips";

describe("stripRanges", () => {
  const c = {
    lap: { speed_kmh: [100, 250, 180], steering: [0.1, -0.4, 0.2] },
    ref: { speed_kmh: [90, 260], steering: [0.5, -0.2] },
    delta: [0, 0.3, -0.5, 0.1],
  };
  it("pads speed by 5 over both laps", () => expect(stripRanges(c).speed).toEqual([85, 265]));
  it("fixes the pedal range", () => expect(stripRanges(c).pedals).toEqual([-0.05, 1.05]));
  it("makes steering symmetric over both laps", () => {
    const [lo, hi] = stripRanges(c).steering;
    expect(hi).toBeCloseTo(0.525);
    expect(lo).toBeCloseTo(-0.525);
  });
  it("makes delta symmetric at 1.1 x max |delta|", () => {
    const [lo, hi] = stripRanges(c).delta;
    expect(hi).toBeCloseTo(0.55);
    expect(lo).toBeCloseTo(-0.55);
  });
  it("copes with empty and flat data", () => {
    const e = stripRanges({ lap: { speed_kmh: [], steering: [] }, ref: { speed_kmh: [], steering: [] }, delta: [0, 0] });
    expect(e.speed).toEqual([-5, 305]);
    expect(e.delta[1]).toBeGreaterThan(0);
    expect(e.steering[1]).toBeGreaterThan(0);
  });
});

describe("chip layer", () => {
  it("maps the scale to a width and an offset", () => {
    // 700 m over 700 px: 1 px/m; data starts at 0, the scale at 100, so the layer shifts left by 100.
    const g = chipLayerGeometry(100, 800, 700, 0, 0, 7000);
    expect(g.widthPx).toBe(7000);
    expect(g.offsetPx).toBe(-100);
  });
  it("includes the plot's left offset and negative scale starts", () => {
    const g = chipLayerGeometry(-350, 350, 700, 10, 0, 1000);
    expect(g.offsetPx).toBe(10 + 350);
  });
  it("places a chip so layer offset + fraction x width equals its scale position", () => {
    const [smin, smax, w] = [1200, 1900, 560];
    const g = chipLayerGeometry(smin, smax, w, 0, 0, 7000);
    expect(g.offsetPx + chipFraction(1550, 0, 7000) * g.widthPx).toBeCloseTo(valueToPx(1550, smin, smax, w));
    expect(valueToPx(1550, smin, smax, w)).toBeCloseTo(w / 2);
  });
});

describe("clipBand", () => {
  it("clips to the plot", () => {
    expect(clipBand(-20, 50, 0, 100)).toEqual([0, 50]);
    expect(clipBand(80, 300, 0, 100)).toEqual([80, 100]);
  });
  it("returns null when out of view or empty", () => {
    expect(clipBand(120, 200, 0, 100)).toBeNull();
    expect(clipBand(-50, -10, 0, 100)).toBeNull();
    expect(clipBand(40, 40, 0, 100)).toBeNull();
  });
});

describe("withAlpha", () => {
  it("appends a two-digit hex alpha", () => {
    expect(withAlpha("#FF7A59", 1)).toBe("#FF7A59ff");
    expect(withAlpha("#FF7A59", 0)).toBe("#FF7A5900");
    expect(withAlpha("#FF7A59", 0.8)).toBe("#FF7A59cc");
  });
});
