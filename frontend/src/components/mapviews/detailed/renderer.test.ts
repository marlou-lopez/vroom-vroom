import { describe, expect, it } from "vitest";
import { zoomScale } from "../../../lib/camera";
import { CHEVRON_LEN_PX, FALLBACK_CAR_DIMS, REF_DASH_PX, REF_GAP_PX, carDimsOrFallback, dashWorld, mixSrgb, showFootprint } from "./renderer";

describe("mixSrgb", () => {
  it("mixes in sRGB space", () => {
    expect(mixSrgb("#000000", "#ffffff", 0.5)).toBe("#808080");
    expect(mixSrgb("#102030", "#102030", 0.7)).toBe("#102030");
    expect(mixSrgb("#23272E", "#D8DCE2", 0)).toBe("#23272e");
  });
});

describe("dashWorld", () => {
  it("keeps the dash the same on screen at every zoom", () => {
    const a = dashWorld(300, 600, 1), b = dashWorld(150, 600, 1);
    expect(a.dash / b.dash).toBeCloseTo(2);
    expect(a.dash).toBeCloseTo(REF_DASH_PX * 0.5);
    expect(a.gap).toBeCloseTo(REF_GAP_PX * 0.5);
  });
  it("follows the line width scale", () => {
    expect(dashWorld(100, 500, 1.8).dash).toBeCloseTo(1.8 * dashWorld(100, 500, 1).dash);
  });
});

describe("showFootprint", () => {
  const dims = { length_m: 4.7, width_m: 2 };
  it("draws the true-size car zoomed in and the marker zoomed out", () => {
    expect(showFootprint(dims, 20, 600)).toBe(true); // 141 px long
    expect(showFootprint(dims, 50, 600)).toBe(true);
    expect(showFootprint(dims, 300, 600)).toBe(false); // 9.4 px < 12 px chevron
    expect(showFootprint(dims, 2000, 600)).toBe(false);
  });
  it("switches where the car is as long on screen as the chevron (zoomScale included)", () => {
    // 600 px wide, 120 m across: 5 px/m, 4.7 m = 23.5 px >= 12 * zoomScale(120) (< 1.8)
    expect(showFootprint(dims, 120, 600)).toBe(4.7 * 5 >= CHEVRON_LEN_PX * zoomScale(120));
    // Just below / above the threshold width for a 600 px viewport and zoomScale 1 (>= 300 m).
    expect(showFootprint(dims, 4.7 * 600 / CHEVRON_LEN_PX + 1, 600)).toBe(false);
    expect(showFootprint(dims, 4.7 * 600 / (CHEVRON_LEN_PX * 1.8) - 1, 600)).toBe(true);
  });
  it("needs a longer car to flip earlier", () => {
    expect(showFootprint({ length_m: 10, width_m: 2 }, 150, 600)).toBe(true);
    expect(showFootprint({ length_m: 1, width_m: 2 }, 150, 600)).toBe(false);
  });
});

describe("carDimsOrFallback", () => {
  it("uses the contract's dims, else the generic GT3 size", () => {
    const d = { length_m: 4.96, width_m: 2.04 };
    expect(carDimsOrFallback(d)).toBe(d);
    expect(carDimsOrFallback(null)).toBe(FALLBACK_CAR_DIMS);
    expect(FALLBACK_CAR_DIMS).toEqual({ length_m: 4.7, width_m: 2.0 });
  });
});
