import { describe, expect, it } from "vitest";
import { GAIN_FULL, GAIN_NEUTRAL, gainRate, gainStrength } from "./gainLoss";

describe("gainRate", () => {
  it("returns the slope of a straight delta (s per metre)", () => {
    const delta = Array.from({ length: 200 }, (_, i) => 0.001 * i);
    const r = gainRate(delta);
    for (let i = 40; i < 160; i++) expect(r[i]).toBeCloseTo(0.001, 12);
  });

  it("spreads a sudden loss over a bell-shaped ±30 m (3 passes of ±10 m), keeping its total", () => {
    const delta = Array.from({ length: 200 }, (_, i) => (i > 100 ? 0.31 : 0));
    const r = gainRate(delta, 10, 3);
    let total = 0;
    for (const v of r) total += v;
    expect(total).toBeCloseTo(0.31, 12);
    expect(r[100]).toBeGreaterThan(r[90]);
    expect(r[90]).toBeGreaterThan(r[80]);
    expect(r[90]).toBeCloseTo(r[110], 12);
    expect(r[70]).toBeGreaterThan(0);
    // Rolling sums leave ~1e-35 instead of exact zeros.
    expect(r[69]).toBeCloseTo(0, 15);
    expect(r[131]).toBeCloseTo(0, 15);
  });

  it("one pass is a plain moving average", () => {
    const delta = Array.from({ length: 200 }, (_, i) => (i > 100 ? 0.31 : 0));
    const r = gainRate(delta, 15, 1);
    expect(r[85]).toBeCloseTo(0.01, 12);
    expect(r[115]).toBeCloseTo(0.01, 12);
    expect(r[84]).toBe(0);
  });

  it("does not treat the reset at start/finish as a gain", () => {
    // Behind by 0.5 s at the end of the lap; the delta restarts at 0 on the next lap.
    const delta = Array.from({ length: 500 }, (_, i) => 0.001 * i);
    const r = gainRate(delta);
    expect(r[0]).toBeCloseTo(0.001, 12);
    expect(r[499]).toBeCloseTo(0.001, 12);
    expect(Math.min(...r)).toBeGreaterThan(0.0009);
  });

  it("averages across start/finish: a loss just after the line also shows just before it", () => {
    const delta = Array.from({ length: 500 }, (_, i) => (i >= 3 ? 0.03 : 0));
    const r = gainRate(delta);
    expect(r[495]).toBeGreaterThan(0);
  });
});

describe("gainStrength", () => {
  it("is 0 inside the neutral band", () => {
    expect(gainStrength(0)).toBe(0);
    expect(gainStrength(GAIN_NEUTRAL)).toBe(0);
    expect(gainStrength(-GAIN_NEUTRAL * 0.9)).toBe(0);
    expect(gainStrength(Number.NaN)).toBe(0);
  });
  it("is positive when losing, negative when gaining, saturating at ±1", () => {
    expect(gainStrength(GAIN_FULL)).toBe(1);
    expect(gainStrength(-GAIN_FULL * 3)).toBe(-1);
    const mid = (GAIN_NEUTRAL + GAIN_FULL) / 2;
    expect(gainStrength(mid)).toBeCloseTo(0.5, 12);
    expect(gainStrength(-mid)).toBeCloseTo(-0.5, 12);
  });
});
