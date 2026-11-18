import { describe, expect, it } from "vitest";
import type { ReportEvent, ReportLap } from "../api/types";
import { headlineEvent, sessionSummary } from "./sessionSummary";

const lap = (n: number, o: Partial<ReportLap> = {}): ReportLap => ({
  lap_id: `l${n}`, lap_no: n, kind: "flying", lap_time_s: 100 + n, valid: true, has_trace: true, tyre_surface_c: null, tyre_carcass_c: null,
  tyre_pressure_kpa: null, brake_c: null, track_temp_c: null, fuel_end_l: null, energy_end_pct: null, settings: null, ...o,
});
const ev = (id: string, from: number, o: Partial<ReportEvent> = {}): ReportEvent => ({
  id, category: "tyres", kind: "k", severity: "info", lap_from: from, lap_to: from, corner: null, distance_m: null, numbers: {}, coincides: null, sentence: id, ...o,
});

describe("sessionSummary", () => {
  it("counts laps, names the best and the spread of timed laps", () => {
    const s = sessionSummary({ laps: [lap(0, { kind: "out" }), lap(1, { lap_time_s: 101.5 }), lap(2, { lap_time_s: 100.25 }), lap(3, { valid: false, lap_time_s: 99 })], events: [] });
    expect(s).toEqual(["4 laps, 2 of them timed and valid.", "Your best was 1:40.250 on lap 2, and your timed laps were within 1.25 s of each other."]);
  });
  it("leads with a problem before a watch event, never an info one", () => {
    const events = [ev("Info first.", 1), ev("Tyres were cold.", 1, { severity: "watch" }), ev("Brakes overheated on lap 5.", 5, { severity: "problem" })];
    expect(headlineEvent(events)?.id).toBe("Brakes overheated on lap 5.");
    expect(sessionSummary({ laps: [lap(1)], events }).at(-1)).toBe("Look at first: brakes overheated on lap 5.");
    expect(headlineEvent([ev("only info", 1)])).toBeNull();
  });
  it("handles no timed laps and no laps", () => {
    expect(sessionSummary({ laps: [lap(1, { kind: "out" })], events: [] })).toEqual(["1 lap, 0 of them timed and valid."]);
    expect(sessionSummary({ laps: [], events: [] })).toEqual(["This session has no laps."]);
  });
});
