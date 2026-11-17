import { describe, expect, it } from "vitest";
import type { CompareCandidate } from "../api/types";
import { comparisonName, standingLabel } from "./compareName";

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
