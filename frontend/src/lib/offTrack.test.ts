import { describe, expect, it } from "vitest";
import type { Corner, TrackMap } from "../api/types";
import { MIN_WHEELS_OFF, OFF_MERGE_GAP_M, invalidHint, likelyInvalidRun, offTrackRuns, placeAt } from "./offTrack";

const corner = (id: string, name: string, start_m: number, apex_m: number, end_m: number): Corner =>
  ({ id, name, start_m, apex_m, end_m, complex: null, approx: false });
const map = (corners: Corner[]): TrackMap => ({ track_id: "t", length_m: 1000, corners, landmarks: [] });
const filled = (n: number, v: number) => new Array<number>(n).fill(v);

describe("offTrackRuns", () => {
  it("marks metres with at least two wheels off and ignores one", () => {
    const w = filled(100, 0);
    w.fill(1, 10, 20);
    w.fill(2, 40, 50);
    w.fill(4, 50, 55);
    expect(MIN_WHEELS_OFF).toBe(2);
    expect(offTrackRuns({ wheels_off: w })).toEqual([{ start: 40, end: 54 }]);
  });
  it("merges stretches closer than the gap and keeps the others apart", () => {
    const w = filled(200, 0);
    w.fill(2, 10, 15);
    w.fill(2, 15 + OFF_MERGE_GAP_M, 40); // exactly OFF_MERGE_GAP_M clear metres between them: bridged
    w.fill(3, 100, 110);
    expect(offTrackRuns({ wheels_off: w })).toEqual([{ start: 10, end: 39 }, { start: 100, end: 109 }]);
    w.fill(0, 25, 26); // one more clear metre: two marks
    expect(offTrackRuns({ wheels_off: w })).toHaveLength(3);
  });
  it("finds nothing on a clean lap", () => {
    expect(offTrackRuns({ wheels_off: filled(50, 0) })).toEqual([]);
    expect(likelyInvalidRun([])).toBeNull();
  });
  it("calls the first stretch the likely cause", () => {
    expect(likelyInvalidRun([{ start: 5, end: 8 }, { start: 90, end: 99 }])).toEqual({ start: 5, end: 8 });
  });
});

describe("placeAt", () => {
  const m = map([corner("c1", "Raidillon", 100, 150, 220), corner("c2", "Wrap", 950, 990, 40)]);
  it("names the corner and its entry or exit", () => {
    expect(placeAt(m, 110)).toBe("Raidillon entry");
    expect(placeAt(m, 150)).toBe("Raidillon");
    expect(placeAt(m, 210)).toBe("Raidillon exit");
  });
  it("handles a corner over the start line", () => {
    expect(placeAt(m, 960)).toBe("Wrap entry");
    expect(placeAt(m, 20)).toBe("Wrap exit");
  });
  it("is near the closest corner on a straight, and a distance without a map", () => {
    expect(placeAt(m, 400)).toBe("near Raidillon");
    expect(placeAt(null, 1234)).toBe("1,234 m");
    expect(placeAt(map([]), 12)).toBe("12 m");
  });
});

describe("invalidHint", () => {
  it("words it as a guess, at the first off-track stretch", () => {
    const w = filled(400, 0);
    w.fill(2, 205, 215);
    w.fill(4, 300, 310);
    expect(invalidHint({ wheels_off: w }, map([corner("c1", "Raidillon", 100, 150, 220)]))).toBe("invalid: Raidillon exit?");
  });
  it("is null with no wheels-off stretch", () => {
    expect(invalidHint({ wheels_off: filled(50, 1) }, null)).toBeNull();
  });
});
