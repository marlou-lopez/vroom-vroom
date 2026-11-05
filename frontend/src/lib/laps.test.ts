import { describe, expect, it } from "vitest";
import type { LapMeta } from "../api/types";
import { bestValidLap } from "./laps";

function lap(id: string, over: Partial<LapMeta> = {}): LapMeta {
  return {
    lap_id: id, session_id: "s", lap_no: 1, kind: "flying", lap_time_s: 100, sectors_s: [],
    valid: true, valid_override: null, pinned_reference: false, source: "own_recording", driver: "d",
    track_id: "t", car_id: "c", conditions: {}, ...over,
  } as LapMeta;
}

describe("bestValidLap", () => {
  it("returns null for no laps", () => {
    expect(bestValidLap([])).toBeNull();
  });

  it("picks the fastest valid flying lap", () => {
    const laps = [lap("a", { lap_time_s: 101 }), lap("b", { lap_time_s: 99.5 }), lap("c", { lap_time_s: 100 })];
    expect(bestValidLap(laps)?.lap_id).toBe("b");
  });

  it("skips laps that are not flying (out and in laps)", () => {
    const laps = [lap("out", { kind: "out", lap_time_s: 90 }), lap("in", { kind: "in", lap_time_s: 91 }), lap("f", { lap_time_s: 120 })];
    expect(bestValidLap(laps)?.lap_id).toBe("f");
  });

  it("skips invalid laps and laps without a time", () => {
    const laps = [lap("bad", { valid: false, lap_time_s: 90 }), lap("none", { lap_time_s: null }), lap("ok", { lap_time_s: 110 })];
    expect(bestValidLap(laps)?.lap_id).toBe("ok");
  });

  it("lets a manual override win over the recorded validity, both ways", () => {
    const rescued = lap("rescued", { valid: false, valid_override: true, lap_time_s: 95 });
    const revoked = lap("revoked", { valid: true, valid_override: false, lap_time_s: 90 });
    expect(bestValidLap([revoked, rescued, lap("x", { lap_time_s: 100 })])?.lap_id).toBe("rescued");
  });

  it("returns null when no lap qualifies", () => {
    expect(bestValidLap([lap("a", { valid: false }), lap("b", { kind: "out" })])).toBeNull();
  });

  it("keeps the first of equal times and returns the original object", () => {
    const a = lap("a", { lap_time_s: 100 });
    const b = lap("b", { lap_time_s: 100 });
    expect(bestValidLap([a, b])).toBe(a);
  });
});
