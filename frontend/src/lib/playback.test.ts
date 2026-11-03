import { describe, expect, it } from "vitest";
import { advanceTau, distanceAtTime, indexAtTime, scrubberPath, steeringDisplay, timeAtDistance } from "./playback";
import { bestValidLap } from "./laps";
import { formatClock, formatDelta, formatLapTime } from "./format";
import type { LapMeta } from "../api/types";

const t = [0, 1, 2.5, 4, 7];

describe("indexAtTime", () => {
  it("is 0 at t = 0 and before", () => {
    expect(indexAtTime(t, 0)).toBe(0);
    expect(indexAtTime(t, -3)).toBe(0);
  });
  it("returns the last index with t[i] <= tau between samples", () => {
    expect(indexAtTime(t, 0.99)).toBe(0);
    expect(indexAtTime(t, 1)).toBe(1);
    expect(indexAtTime(t, 3)).toBe(2);
    expect(indexAtTime(t, 6.9)).toBe(3);
  });
  it("clamps past the end", () => {
    expect(indexAtTime(t, 7)).toBe(4);
    expect(indexAtTime(t, 100)).toBe(4);
  });
  it("handles an empty series", () => {
    expect(indexAtTime([], 5)).toBe(0);
  });
});

describe("distanceAtTime / timeAtDistance", () => {
  const d = [0, 10, 20, 30, 40];
  it("interpolates between samples", () => {
    expect(distanceAtTime(t, d, 1.75)).toBeCloseTo(15);
    expect(timeAtDistance(t, d, 15)).toBeCloseTo(1.75);
  });
  it("clamps at both ends", () => {
    expect(distanceAtTime(t, d, 99)).toBe(40);
    expect(timeAtDistance(t, d, -5)).toBe(0);
    expect(timeAtDistance(t, d, 99)).toBe(7);
  });
});

describe("steeringDisplay", () => {
  it("converts to degrees with a known range", () => {
    expect(steeringDisplay(0.5, 540)).toEqual({ value: 135, unit: "deg" });
  });
  it("falls back to percent without a range", () => {
    expect(steeringDisplay(0.5, null)).toEqual({ value: 50, unit: "%" });
  });
});

describe("advanceTau", () => {
  it("advances by dt × rate and wraps to 0 at the end", () => {
    expect(advanceTau(10, 0.5, 2, 100)).toBe(11);
    expect(advanceTau(99.9, 0.1, 1, 100)).toBe(0);
  });
});

describe("scrubberPath", () => {
  it("spans the full width", () => {
    const p = scrubberPath([0, 5, 10], [0, 0.2, -0.1]);
    expect(p.startsWith("M0 ")).toBe(true);
    expect(p).toContain("L1000 ");
  });
});

describe("bestValidLap", () => {
  const mk = (no: number, time: number, over: Partial<LapMeta> = {}): LapMeta => ({
    lap_id: `l${no}`, session_id: "s", lap_no: no, kind: "flying", lap_time_s: time, sectors_s: [], valid: true,
    valid_override: null, pinned_reference: false, source: "own_recording", driver: "", track_id: "t", car_id: "c",
    conditions: {}, ...over,
  });
  it("skips invalid and non-flying laps and honours valid_override", () => {
    const laps = [mk(1, 90, { kind: "out" }), mk(2, 80, { valid: false }), mk(3, 85), mk(4, 82, { valid: false, valid_override: true })];
    expect(bestValidLap(laps)?.lap_id).toBe("l4");
    expect(bestValidLap([mk(1, 90, { kind: "in" })])).toBeNull();
  });
});

describe("format", () => {
  it("formats lap times, clocks and deltas", () => {
    expect(formatLapTime(143.751)).toBe("2:23.751");
    expect(formatLapTime(61.005)).toBe("1:01.005");
    expect(formatClock(92.04)).toBe("1:32.0");
    expect(formatDelta(0.8412)).toBe("+0.841");
    expect(formatDelta(-0.12)).toBe("−0.120");
  });
});
