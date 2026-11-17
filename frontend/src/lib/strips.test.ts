import { describe, expect, it } from "vitest";
import { chipFraction, chipLayerGeometry, clipBand, cornerBands, distanceTicks, elevationRange, fitCorner, parseWindowMode, pickCorner, stripDistanceAt, stripRanges, stripScrubTarget, stripView, stripWindow, valueToPx, withAlpha } from "./strips";

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

describe("cornerBands", () => {
  it("is one band with both edges for a normal corner", () => {
    expect(cornerBands(100, 220, 7000)).toEqual([{ d0: 100, d1: 220, startEdge: true, endEdge: true }]);
  });
  it("splits a corner over the start line, with edges only at the real start and end", () => {
    expect(cornerBands(6900, 120, 7000)).toEqual([
      { d0: 6900, d1: 7000, startEdge: true, endEdge: false },
      { d0: 0, d1: 120, startEdge: false, endEdge: true },
    ]);
  });
});

describe("strip window modes (vroom-pnw.35)", () => {
  const corners = [{ startM: 100, endM: 200 }, { startM: 500, endM: 560 }, { startM: 6900, endM: 40 }];
  it("parses a stored mode, defaulting to 700", () => {
    expect(parseWindowMode("lap")).toBe("lap");
    expect(parseWindowMode("corner")).toBe("corner");
    expect(parseWindowMode("bogus")).toBe("700");
    expect(parseWindowMode(null)).toBe("700");
  });
  it("picks the corner under the playhead, else the next ahead, wrapping to the first", () => {
    expect(pickCorner(corners, 150)).toBe(corners[0]);
    expect(pickCorner(corners, 300)).toBe(corners[1]);
    expect(pickCorner(corners, 6950)).toBe(corners[2]);
    expect(pickCorner(corners, 20)).toBe(corners[2]);
    expect(pickCorner(corners.slice(0, 2), 700)).toBe(corners[0]);
    expect(pickCorner([], 5)).toBeNull();
  });
  it("fits a corner with padding and a floor", () => {
    expect(fitCorner({ startM: 100, endM: 300 }, 150, 7000)).toEqual({ centre: 200, half: 100 + 50 });
    expect(fitCorner({ startM: 500, endM: 520 }, 510, 7000)).toEqual({ centre: 510, half: 60 });
    // Over the start line: the half that holds d.
    expect(fitCorner({ startM: 6900, endM: 40 }, 6950, 7000).centre).toBe(6950);
    expect(fitCorner({ startM: 6900, endM: 40 }, 10, 7000).centre).toBe(20);
  });
  it("builds the window per mode", () => {
    expect(stripView("700", 1000, 0, 7000, null)).toEqual({ min: 650, max: 1350, playhead: 0.5 });
    expect(stripView("lap", 1750, 0, 7000, null)).toEqual({ min: 0, max: 7000, playhead: 0.25 });
    const w = stripView("corner", 150, 0, 7000, corners[0]);
    expect(w.min).toBeCloseTo(100 - 40 - 0, 5);
    expect(w.max).toBeCloseTo(200 + 40, 5);
    expect(w.min).toBeGreaterThanOrEqual(0);
    expect(w.playhead).toBeCloseTo((150 - w.min) / (w.max - w.min), 9);
    // Playhead outside the fitted corner window is reported, not clamped.
    expect(stripView("corner", 400, 0, 7000, corners[0]).playhead).toBeGreaterThan(1);
    // No corner: falls back to 700.
    expect(stripView("corner", 1000, 0, 7000, null)).toEqual(stripView("700", 1000, 0, 7000, null));
  });
  it("clamps a corner window to the lap and a tiny lap", () => {
    const w = stripView("corner", 5, 0, 7000, { startM: 0, endM: 30 });
    expect(w.min).toBe(0);
    expect(w.max - w.min).toBe(2 * 60);
  });
  it("makes 1/2/5 distance ticks inside the window", () => {
    expect(distanceTicks(0, 700)).toEqual([0, 100, 200, 300, 400, 500, 600, 700]);
    expect(distanceTicks(0, 7000, 7)).toEqual([0, 1000, 2000, 3000, 4000, 5000, 6000, 7000]);
    expect(distanceTicks(95, 245, 5)).toEqual([100, 150, 200]);
    expect(distanceTicks(5, 5)).toEqual([]);
  });
});
