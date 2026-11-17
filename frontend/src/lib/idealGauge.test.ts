import { describe, expect, it } from "vitest";
import type { IdealLap, IdealSegment, SegmentTimes } from "../api/types";
import { cellTone, formatGap, lapAtHref, lapGauges, segmentCells } from "./idealGauge";

const seg = (k: number, best_s: number, lap_id: string): IdealSegment => ({
  label: `S${k}`, corner_id: null, start_m: k * 100, end_m: (k + 1) * 100, best_s, lap_id, lap_no: Number(lap_id.slice(1)), session_id: "s",
});
const ideal: IdealLap = { scope: "session", time_s: 30, segments: [seg(0, 10, "a"), seg(1, 10, "b"), seg(2, 10, "a")] };
const times: SegmentTimes = {
  laps: [
    { lap_id: "a", lap_no: 1, segment_s: [10, 10.4, 10] },
    { lap_id: "b", lap_no: 2, segment_s: [10.05, 10, 10.2] },
    { lap_id: "c", lap_no: 3, segment_s: [11, 10.5, 10.1] },
  ],
};
const lapTimes = new Map([["a", 30.4], ["b", 30.25], ["c", 31.6]]);

describe("cellTone", () => {
  it("is purple for a held segment or a tie, then shades by time lost", () => {
    expect(cellTone(0, true)).toBe("purple");
    expect(cellTone(0.0002, false)).toBe("purple");
    expect(cellTone(0.05, false)).toBe("green");
    expect(cellTone(0.1, false)).toBe("green");
    expect(cellTone(0.2, false)).toBe("yellow");
    expect(cellTone(0.3, false)).toBe("yellow");
    expect(cellTone(0.31, false)).toBe("red");
  });
});

describe("segmentCells", () => {
  it("marks the segments the lap holds purple and the others by loss", () => {
    const cells = segmentCells("a", [10, 10.4, 10], ideal);
    expect(cells.map((c) => c.tone)).toEqual(["purple", "red", "purple"]);
    expect(cells[1].loss_s).toBeCloseTo(0.4);
    expect(cells[0].loss_s).toBe(0);
  });
});

describe("lapGauges", () => {
  const g = lapGauges(ideal, times, lapTimes);
  it("gives the gap to the ideal and to the best lap", () => {
    expect(g.get("a")!.gapToIdealS).toBeCloseTo(0.4);
    expect(g.get("b")!.gapToIdealS).toBeCloseTo(0.25);
    expect(g.get("b")!.gapToBestS).toBe(0);
    expect(g.get("c")!.gapToBestS).toBeCloseTo(1.35);
  });
  it("shades each lap's strip, one cell per segment", () => {
    expect(g.get("c")!.cells.map((c) => c.tone)).toEqual(["red", "red", "green"]);
    expect(g.get("b")!.cells.map((c) => c.tone)).toEqual(["green", "purple", "yellow"]);
    expect(g.get("a")!.cells).toHaveLength(3);
  });
  it("skips laps without a time", () => {
    expect([...lapGauges(ideal, times, new Map([["a", 30.4]])).keys()]).toEqual(["a"]);
  });
});

describe("format", () => {
  it("formats gaps and links", () => {
    expect(formatGap(0.4123)).toBe("+0.412");
    expect(formatGap(null)).toBe("—");
    expect(lapAtHref("l 1", 412.6)).toBe("/?lap=l%201&at=413");
  });
});
