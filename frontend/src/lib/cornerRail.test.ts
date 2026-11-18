import { describe, expect, it } from "vitest";
import type { CompareResponse, Corner, CornerMetrics } from "../api/types";
import { causeDirection, cornerRailRows } from "./cornerRail";

const side = { brake_onset_m: 100, peak_brake: 1, min_speed_kmh: 100, min_speed_m: 120, throttle_pickup_m: 140, exit_speed_kmh: 150, coast_s: 0, overlap_s: 0, steer_corrections: 0, understeer_peak_deg_s: null, understeer_mean_deg_s: null };
const m = (id: string, d: number, lap: Partial<typeof side> = {}): CornerMetrics => ({ corner_id: id, delta_s: d, lap: { ...side, ...lap }, ref: side });
const corner = (id: string, start: number): Corner => ({ id, name: `T${id}`, start_m: start, apex_m: start + 20, end_m: start + 40, complex: null, approx: false });
const cmp = (corners: CornerMetrics[], ref = "b") => ({ lap_id: "a", ref_lap_id: ref, corners }) as unknown as CompareResponse;

describe("causeDirection", () => {
  it("gives a direction for losses", () => {
    expect(causeDirection(m("1", 0.2, { min_speed_kmh: 90 }))).toBe("lower min speed");
    expect(causeDirection(m("1", 0.2, { brake_onset_m: 70 }))).toBe("earlier braking");
    expect(causeDirection(m("1", 0.2, { brake_onset_m: 130 }))).toBe("later braking");
    expect(causeDirection(m("1", 0.2, { throttle_pickup_m: 170 }))).toBe("later throttle");
    expect(causeDirection(m("1", 0.2, { steer_corrections: 4 }))).toBe("more steering corrections");
  });
  it("scores a gain with the laps swapped", () => {
    expect(causeDirection(m("1", -0.1, { min_speed_kmh: 110 }))).toBe("higher min speed");
    expect(causeDirection(m("1", -0.1, { throttle_pickup_m: 100 }))).toBe("earlier throttle");
  });
  it("shows no direction when nothing stands out", () => {
    expect(causeDirection(m("1", 0.2))).toBeNull();
    expect(causeDirection(m("1", -0.2))).toBeNull();
  });
  it("is null for an even corner", () => {
    expect(causeDirection(m("1", 0.0004))).toBeNull();
  });
});

describe("cornerRailRows", () => {
  const cs = [corner("1", 300), corner("2", 100), corner("3", 200)];
  it("lists every corner in track order with its kind", () => {
    const rows = cornerRailRows(cmp([m("1", 0.1), m("2", -0.2), m("3", 0.0002)]), cs);
    expect(rows.map((r) => [r.corner.id, r.kind])).toEqual([["2", "gain"], ["3", "even"], ["1", "loss"]]);
  });
  it("skips corners missing from the map", () => {
    expect(cornerRailRows(cmp([m("9", 0.5)]), cs)).toEqual([]);
  });
  it("is empty when the lap is its own reference", () => {
    expect(cornerRailRows(cmp([m("1", 0.1)], "a"), cs)).toEqual([]);
  });
});
