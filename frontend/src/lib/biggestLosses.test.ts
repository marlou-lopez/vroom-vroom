import { describe, expect, it } from "vitest";
import type { CompareResponse, Corner, CornerMetrics } from "../api/types";
import { biggestLosses } from "./biggestLosses";

const side = { brake_onset_m: 100, peak_brake: 1, min_speed_kmh: 100, min_speed_m: 120, throttle_pickup_m: 140, exit_speed_kmh: 150, coast_s: 0, overlap_s: 0, steer_corrections: 0, understeer_peak_deg_s: null, understeer_mean_deg_s: null };
const m = (id: string, d: number, lap: Partial<typeof side> = {}): CornerMetrics => ({ corner_id: id, delta_s: d, lap: { ...side, ...lap }, ref: side });
const corner = (id: string): Corner => ({ id, name: `T${id}`, start_m: 100, apex_m: 120, end_m: 140, complex: null, approx: false });
const cmp = (corners: CornerMetrics[], ref = "b") => ({ lap_id: "a", ref_lap_id: ref, corners }) as unknown as CompareResponse;
const cs = ["1", "2", "3", "4", "5", "6"].map(corner);

describe("biggestLosses", () => {
  it("ranks the three largest losses and the single biggest gain", () => {
    const r = biggestLosses(cmp([m("1", 0.1), m("2", 0.3), m("3", -0.05), m("4", 0.2), m("5", 0.15), m("6", -0.2)]), cs)!;
    expect(r.losses.map((l) => l.cornerId)).toEqual(["2", "4", "5"]);
    expect(r.gain?.cornerId).toBe("6");
  });
  it("names the cause with the coach's scoring", () => {
    const r = biggestLosses(cmp([m("1", 0.2, { min_speed_kmh: 90 }), m("2", 0.1, { brake_onset_m: 70 })]), cs)!;
    expect(r.losses.map((l) => l.cause)).toEqual(["speed", "brake"]);
  });
  it("scores a gain with the laps swapped", () => {
    const g: CornerMetrics = { corner_id: "1", delta_s: -0.1, lap: { ...side, min_speed_kmh: 110 }, ref: side };
    expect(biggestLosses(cmp([g]), cs)!.gain?.cause).toBe("speed");
    const g2: CornerMetrics = { corner_id: "1", delta_s: -0.1, lap: { ...side, throttle_pickup_m: 100 }, ref: side };
    expect(biggestLosses(cmp([g2]), cs)!.gain?.cause).toBe("throttle");
  });
  it("skips near-zero corners and corners missing from the map", () => {
    const r = biggestLosses(cmp([m("1", 0.0004), m("9", 0.5)]), cs)!;
    expect(r.losses).toEqual([]);
    expect(r.gain).toBeNull();
  });
  it("is null when the lap is its own reference", () => {
    expect(biggestLosses(cmp([m("1", 0.1)], "a"), cs)).toBeNull();
  });
});
