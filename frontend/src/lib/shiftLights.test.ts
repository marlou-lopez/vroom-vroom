import { describe, expect, it } from "vitest";
import { FLASH_FRACTION, LED_COUNT, deriveRpmLimits, ledColour, preUpshiftRpm, quantile, shiftLights } from "./shiftLights";

describe("quantile", () => {
  it("interpolates and handles the ends", () => {
    expect(quantile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantile([10, 20], 0.5)).toBe(15);
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([], 0.5)).toBeNaN();
  });
});

describe("preUpshiftRpm", () => {
  it("takes the peak just before each forward upshift, and ignores downshifts, neutral and reverse", () => {
    const gear = [1, 1, 1, 1, 2, 2, 2, 2, 1, 1, 0, 0, -1, -1, 1, 1, 2];
    const rpm = [5000, 6000, 7900, 7800, 4000, 5000, 6000, 7000, 8000, 9000, 1000, 1000, 2000, 2000, 3000, 4000, 2000];
    expect(preUpshiftRpm(rpm, gear)).toEqual([7900, 4000]);
  });
});

describe("deriveRpmLimits", () => {
  const lap = (peaks: number[]) => {
    const rpm: number[] = [], gear: number[] = [];
    peaks.forEach((p, i) => { rpm.push(p - 400, p - 100, p, p - 1500); gear.push(i + 1, i + 1, i + 1, i + 2); });
    return { rpm, gear };
  };
  it("takes a high percentile of the pre-upshift rpm", () => {
    const { rpm, gear } = lap([8600, 8700, 8650, 8800, 8750, 8200]);
    const l = deriveRpmLimits(rpm, gear)!;
    expect(l.limit).toBeGreaterThan(8700);
    expect(l.limit).toBeLessThanOrEqual(8800);
    expect(l.start).toBeCloseTo(l.limit * 0.8, 6);
  });
  it("falls back to the highest rpm with fewer than three upshifts, and to null with no rpm", () => {
    expect(deriveRpmLimits([3000, 5000, 7000, 6000], [2, 2, 2, 2])!.limit).toBe(7000);
    expect(deriveRpmLimits([], [])).toBeNull();
    expect(deriveRpmLimits([0, 0], [1, 1])).toBeNull();
  });
});

describe("lights", () => {
  const limits = { limit: 9000, start: 7200 };
  it("colours: green, then yellow, then red", () => {
    const c = Array.from({ length: LED_COUNT }, (_, i) => ledColour(i));
    expect(c.slice(0, 4)).toEqual(Array(4).fill("green"));
    expect(c.slice(4, 8)).toEqual(Array(4).fill("yellow"));
    expect(c.slice(8)).toEqual(["red", "red"]);
  });
  it("fills evenly between start and limit and is dark below start", () => {
    expect(shiftLights(5000, limits, 0).lit).toBe(0);
    expect(shiftLights(7200, limits, 0).lit).toBe(0);
    expect(shiftLights(7300, limits, 0).lit).toBe(1);
    expect(shiftLights(8100, limits, 0).lit).toBe(5);
    expect(shiftLights(8860, limits, 0).lit).toBe(LED_COUNT);
    expect(shiftLights(8860, limits, 0).flashing).toBe(false);
  });
  it("flashes at the limit, following the clock", () => {
    const r = limits.limit * FLASH_FRACTION;
    const a = shiftLights(r, limits, 0), b = shiftLights(r, limits, 1 / 12);
    expect(a.flashing && b.flashing).toBe(true);
    expect(a.flashOn).not.toBe(b.flashOn);
    expect(shiftLights(9500, limits, 0).lit).toBe(LED_COUNT);
  });
  it("is dark without limits", () => {
    expect(shiftLights(8000, null, 0)).toEqual({ lit: 0, flashing: false, flashOn: true });
  });
});
