import { describe, expect, it } from "vitest";
import { REF_DASH_PX, REF_GAP_PX, dashWorld, mixSrgb } from "./renderer";

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
