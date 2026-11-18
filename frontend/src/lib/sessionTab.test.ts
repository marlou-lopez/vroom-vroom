import { describe, expect, it } from "vitest";
import type { ReportEvent, ReportLap } from "../api/types";
import { eventLap, groupEvents, lapRangeLabel, lapSeverity, lapTimeRange, sessionBestLap, yRange } from "./sessionTab";

const lap = (n: number, o: Partial<ReportLap> = {}): ReportLap => ({
  lap_id: `l${n}`, lap_no: n, kind: "flying", lap_time_s: 100 + n, valid: true, has_trace: true, tyre_surface_c: null, tyre_carcass_c: null,
  tyre_pressure_kpa: null, brake_c: null, track_temp_c: null, fuel_end_l: null, energy_end_pct: null, settings: null, ...o,
});
const ev = (id: string, from: number, to: number, o: Partial<ReportEvent> = {}): ReportEvent => ({
  id, category: "tyres", kind: "k", severity: "info", lap_from: from, lap_to: to, corner: null, distance_m: null, numbers: {}, coincides: null, sentence: id, ...o,
});

describe("sessionTab", () => {
  it("picks the best valid flying lap with a trace", () => {
    const laps = [lap(1, { lap_time_s: 90, has_trace: false }), lap(2, { lap_time_s: 95, valid: false }), lap(3, { lap_time_s: 97 }), lap(4, { lap_time_s: 99 }), lap(5, { kind: "in", lap_time_s: 80 })];
    expect(sessionBestLap(laps)?.lap_no).toBe(3);
    expect(sessionBestLap([lap(1, { has_trace: false })])).toBeNull();
  });
  it("finds an event's lap: the first with a trace in its range", () => {
    const laps = [lap(1, { has_trace: false }), lap(2), lap(3)];
    expect(eventLap(ev("a", 1, 3), laps)?.lap_no).toBe(2);
    expect(eventLap(ev("a", 1, 1), laps)?.lap_no).toBe(1);
    expect(eventLap(ev("a", 9, 9), laps)).toBeNull();
  });
  it("scales to values and window, with padding", () => {
    expect(yRange([], null)).toBeNull();
    const r = yRange([90, 95], { min: 80, max: 100 })!;
    expect(r.lo).toBeLessThan(80);
    expect(r.hi).toBeGreaterThan(100);
    const flat = yRange([5], null)!;
    expect(flat.hi).toBeGreaterThan(flat.lo);
  });
  it("clamps the lap-time axis to ten percent over the median", () => {
    const laps = [lap(1, { lap_time_s: 100 }), lap(2, { lap_time_s: 101 }), lap(3, { lap_time_s: 102 }), lap(4, { lap_time_s: 200 })];
    expect(lapTimeRange(laps)!.hi).toBeLessThan(115);
    expect(lapTimeRange([lap(1, { kind: "out" })])).toBeNull();
  });
  it("gives each lap its worst event severity across the range", () => {
    const m = lapSeverity([ev("a", 1, 3, { severity: "watch" }), ev("b", 2, 2, { severity: "problem" }), ev("c", 3, 3)]);
    expect([m.get(1), m.get(2), m.get(3), m.get(4)]).toEqual(["watch", "problem", "watch", undefined]);
  });
  it("groups events by lap range and filters by category", () => {
    const events = [ev("a", 1, 3), ev("b", 2, 2, { category: "brakes" }), ev("c", 1, 3, { category: "pace" })];
    expect(groupEvents(events, new Set()).map((g) => [g.label, g.events.length])).toEqual([["Laps 1–3", 2], ["Lap 2", 1]]);
    expect(groupEvents(events, new Set(["brakes"])).map((g) => g.label)).toEqual(["Lap 2"]);
    expect(lapRangeLabel(4, 4)).toBe("Lap 4");
  });
});
