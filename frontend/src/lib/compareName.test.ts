import { describe, expect, it } from "vitest";
import type { CompareCandidate } from "../api/types";
import { comparisonName, lapGap, standingLabel } from "./compareName";

const cand = (over: Partial<CompareCandidate>): CompareCandidate => ({
  lap_id: "x", label: "3 Nov · L9 1:23.456", lap_time_s: 83.456, car_name: "C", is_reference: false, is_previous: false, other_car: false, is_ideal: false, ...over,
});

describe("comparisonName", () => {
  const laps = [{ lap_id: "a", lap_no: 7 }];
  it("names the ideal, the reference, a lap of the session, and another session's lap", () => {
    expect(comparisonName(cand({ is_ideal: true }), laps)).toBe("ideal");
    expect(comparisonName(cand({ is_reference: true }), laps)).toBe("reference");
    expect(comparisonName(cand({ lap_id: "a" }), laps)).toBe("L7");
    expect(comparisonName(cand({ lap_id: "z" }), laps)).toBe("3 Nov · L9 1:23.456");
    expect(comparisonName(null, laps)).toBeNull();
  });
});

describe("standingLabel", () => {
  it("says behind or ahead of the named comparison, and nothing when level or unnamed", () => {
    expect(standingLabel(0.4, "ideal")).toBe("behind ideal");
    expect(standingLabel(-0.4, "L7")).toBe("ahead of L7");
    expect(standingLabel(0.001, "L7")).toBeNull();
    expect(standingLabel(0.4, null)).toBeNull();
  });
});

describe("lapGap", () => {
  it("is the lap-time gap when both times are known, so the bar agrees with the lap list", () => {
    expect(lapGap(143.751, 143.7, 0.036)).toBeCloseTo(0.051, 6);
    expect(lapGap(143.6, 143.7, 0.036)).toBeCloseTo(-0.1, 6);
  });
  it("falls back to the last delta sample", () => {
    expect(lapGap(null, 143.7, 0.036)).toBe(0.036);
    expect(lapGap(143.7, 0, null)).toBeNull();
  });
});
