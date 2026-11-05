import { describe, expect, it } from "vitest";
import { chipFraction, chipLayerGeometry, clipBand, elevationRange, stripDistanceAt, stripRanges, stripScrubTarget, stripWindow, valueToPx, withAlpha } from "./strips";

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

describe("stripDistanceAt", () => {
  it("maps the strip edges and middle onto the window", () => {
    expect(stripDistanceAt(0, 800, 1000, 350)).toBe(650);
    expect(stripDistanceAt(800, 800, 1000, 350)).toBe(1350);
    expect(stripDistanceAt(400, 800, 1000, 350)).toBe(1000);
  });
  it("returns the centre for a degenerate width", () => {
    expect(stripDistanceAt(10, 0, 1000, 350)).toBe(1000);
    expect(stripDistanceAt(10, -5, 1000, 350)).toBe(1000);
  });
});

describe("stripScrubTarget", () => {
  it("drag left moves forward, right moves back", () => {
    expect(stripScrubTarget(1000, -400, 800, 350, 0, 5000)).toBe(1350);
    expect(stripScrubTarget(1000, 400, 800, 350, 0, 5000)).toBe(650);
    expect(stripScrubTarget(1000, 0, 800, 350, 0, 5000)).toBe(1000);
  });
  it("clamps at the lap start and end", () => {
    expect(stripScrubTarget(100, 800, 800, 350, 0, 5000)).toBe(0);
    expect(stripScrubTarget(4900, -800, 800, 350, 0, 5000)).toBe(5000);
  });
  it("returns the start for a degenerate width", () => {
    expect(stripScrubTarget(1000, -50, 0, 350, 0, 5000)).toBe(1000);
  });
});

describe("stripWindow", () => {
  it("is centred on the playhead mid-lap", () => {
    expect(stripWindow(3000, 350, 0, 6979)).toEqual({ min: 2650, max: 3350, playhead: 0.5 });
  });
  it("starts at the lap start near the start, with the playhead left of centre", () => {
    expect(stripWindow(0, 350, 0, 6979)).toEqual({ min: 0, max: 700, playhead: 0 });
    expect(stripWindow(175, 350, 0, 6979)).toEqual({ min: 0, max: 700, playhead: 0.25 });
  });
  it("ends at the lap end near the end, with the playhead right of centre", () => {
    expect(stripWindow(6979, 350, 0, 6979)).toEqual({ min: 6279, max: 6979, playhead: 1 });
  });
  it("starts at the lap start when the lap is shorter than the window", () => {
    expect(stripWindow(100, 350, 0, 400)).toEqual({ min: 0, max: 700, playhead: 100 / 700 });
  });
});

describe("elevationRange", () => {
  it("spans both laps with 5 % padding, ignoring nulls", () => {
    expect(elevationRange([0, null, 100], [-20, 50])).toEqual([-26, 106]);
  });
  it("keeps at least 10 m of span on a flat lap", () => {
    const [lo, hi] = elevationRange([5, 5], [5, null]);
    expect(hi - lo).toBeCloseTo(10, 6);
    expect((lo + hi) / 2).toBeCloseTo(5, 6);
  });
  it("has a default when there is no data", () => expect(elevationRange([null], [])).toEqual([-5, 5]));
});
