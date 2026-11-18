import { describe, expect, it } from "vitest";
import type { Corner, LapKind, StintLap, Wheels } from "../api/types";
import type { AidRuns } from "./driverAids";
import { GT3_WINDOWS } from "./reportWindows";
import { buildSessionReport, type ReportInput, type ReportLapInput, type TraceFacts } from "./sessionReport";
import { splitStints } from "../api/mock/stint";

const w = (v: number): Wheels => ({ fl: v, fr: v, rl: v, rr: v });
const CORNERS: Corner[] = [
  { id: "c1", name: "Alpha", start_m: 100, apex_m: 150, end_m: 200, complex: null, approx: false },
  { id: "c2", name: "Beta", start_m: 300, apex_m: 350, end_m: 400, complex: null, approx: false },
];
const none: AidRuns = { abs: [], tc: [], lockup: [], wheelspin: [] };

function stat(n: number, o: Partial<StintLap> & { kind?: LapKind; time?: number } = {}): StintLap {
  return {
    lap_id: `l${n}`, lap_no: n, kind: o.kind ?? "flying", lap_time_s: o.time ?? 100, valid: true,
    fuel_start_l: 40 - n * 2, fuel_end_l: 38 - n * 2, energy_start_pct: null, energy_end_pct: null,
    tyre_surface_c: w(90), tyre_zones_c: { left: w(90), centre: w(90), right: w(90) }, tyre_carcass_c: w(95), tyre_pressure_kpa: w(172),
    tyre_wear_end_pct: w(100 - n), brake_c: w(450), track_temp_c: 30, air_temp_c: 20, ...o,
  };
}
const lapIn = (s: StintLap): ReportLapInput => ({ lap_id: s.lap_id, lap_no: s.lap_no, kind: s.kind, lap_time_s: s.lap_time_s, valid: s.valid, has_trace: false });

function input(stats: StintLap[] | null, o: Partial<ReportInput> = {}, laps?: ReportLapInput[]): ReportInput {
  return {
    session_id: "s", car_class: "GT3", track_length_m: 1000, laps: laps ?? (stats ?? []).map(lapIn), stats,
    stints: stats ? splitStints(stats, "GT3") : [], settings: null, corners: CORNERS, traces: new Map(), aid_activation: new Map(), ...o,
  };
}
const kinds = (r: ReturnType<typeof buildSessionReport>) => r.events.filter((e) => e.category === "tyres" || e.category === "brakes" || e.category === "driving" || e.category === "pace").map((e) => e.kind);

describe("buildSessionReport", () => {
  it("finds nothing in a clean stint", () => {
    const r = buildSessionReport(input([1, 2, 3, 4].map((n) => stat(n))));
    expect(r.events).toEqual([]);
    expect(r.unavailable.map((u) => u.category)).toEqual(["driving", "settings"]);
    expect(r.laps[0].tyre_surface_c).toEqual({ front: 90, rear: 90 });
  });

  it("flags tyre temperature below and above the window per axle, and pressure", () => {
    const cold = (n: number) => stat(n, { tyre_surface_c: { fl: 90, fr: 90, rl: 70, rr: 72 }, tyre_pressure_kpa: { fl: 190, fr: 190, rl: 172, rr: 172 }, tyre_carcass_c: { fl: 95, fr: 95, rl: 95, rr: 95 } });
    const r = buildSessionReport(input([1, 2, 3].map(cold)));
    expect(kinds(r)).toEqual(["tyre_surface_c_low", "tyre_pressure_kpa_high"]);
    const low = r.events[0];
    expect(low).toMatchObject({ category: "tyres", lap_from: 1, lap_to: 3, numbers: { mean: 71, window_min: 80, n_laps: 3 } });
    expect(low.sentence).toContain("Rear tyre surface temperature averaged 71.0 °C");
    const hot = buildSessionReport(input([1, 2].map((n) => stat(n, { tyre_carcass_c: w(120) }))));
    expect(kinds(hot)).toEqual(["tyre_carcass_c_high", "tyre_carcass_c_high"]); // front and rear
  });

  it("needs two laps for a tyre event and ignores out laps for a cold value", () => {
    const cold = { tyre_surface_c: w(60) };
    expect(kinds(buildSessionReport(input([stat(1, { kind: "out", ...cold }), stat(2, cold), stat(3)])))).toEqual(["pit_laps"]);
  });

  it("reports discs cooling on the out lap after a stop, and does not judge in laps", () => {
    const stats = [stat(1), stat(2), stat(3, { kind: "in", brake_c: w(150), tyre_pressure_kpa: w(100) }), stat(4, { kind: "out", brake_c: { fl: 300, fr: 300, rl: 250, rr: 250 } })];
    const r = buildSessionReport(input(stats));
    expect(kinds(r)).toEqual(["pit_laps", "brake_pit_cooling"]);
    expect(r.events[1].numbers).toMatchObject({ front_c: 300, rear_c: 250, front_before_c: 450, rear_before_c: 450 });
  });

  it("reports a pace trend that improves", () => {
    const stats = [1, 2, 3, 4].map((n) => stat(n, { time: 100 - n * 0.4 }));
    const e = buildSessionReport(input(stats)).events.find((x) => x.kind === "pace_improving")!;
    expect(e.sentence).toContain("got faster");
  });

  it("flags a large tread spread", () => {
    const sp = (n: number) => stat(n, { tyre_zones_c: { left: w(80), centre: w(90), right: w(100) } });
    const r = buildSessionReport(input([1, 2].map(sp)));
    expect(kinds(r)).toEqual(["tyre_spread", "tyre_spread"]);
    expect(r.events[0].numbers.mean).toBe(20);
  });

  it("flags brake disc temperature outside the window and a front/rear imbalance", () => {
    const hot = (n: number) => stat(n, { brake_c: { fl: 700, fr: 700, rl: 380, rr: 380 } });
    const r = buildSessionReport(input([1, 2].map(hot)));
    expect(kinds(r)).toContain("brake_high");
    expect(kinds(r)).toContain("brake_imbalance_high");
    expect(r.events.find((e) => e.kind === "brake_imbalance_high")!.numbers.ratio).toBeCloseTo(1.84, 2);
    expect(buildSessionReport(input([stat(1, { brake_c: w(200) })])).events.map((e) => e.kind)).toEqual(["brake_low", "brake_low"]);
  });

  it("links an event to time lost on the same laps, never as a cause", () => {
    const stats = [stat(1, { time: 100 }), stat(2, { time: 101, tyre_surface_c: w(70) }), stat(3, { time: 101.4, tyre_surface_c: w(70) })];
    const e = buildSessionReport(input(stats)).events.find((x) => x.category === "tyres")!;
    expect(e.coincides).toEqual({ scope: "lap", lost_s: 1.2, laps: [2, 3] });
    expect(e.numbers.lost_s).toBe(1.2);
    expect(e.sentence).toContain("coincides with laps 1.20 s slower");
    expect(e.sentence).not.toMatch(/because|grip|load|bias/i);
  });

  it("finds the corner that lost most on the event's laps when the laps have traces", () => {
    const stats = [stat(1, { time: 100 }), stat(2, { time: 101, tyre_surface_c: w(70) }), stat(3, { time: 101, tyre_surface_c: w(70) })];
    const trace = (a: number, b: number): TraceFacts => ({ aids: none, corner_times_s: [a, b] });
    const traces = new Map([[1, trace(5, 6)], [2, trace(5.1, 6.6)], [3, trace(5.1, 6.4)]]);
    const e = buildSessionReport(input(stats, { traces })).events.find((x) => x.category === "tyres")!;
    expect(e.corner).toEqual({ id: "c2", name: "Beta" });
    expect(e.distance_m).toBe(350);
    expect(e.numbers.corner_lost_s).toBe(0.5);
  });

  it("reports lock-ups, wheelspin, ABS and TC activation per corner", () => {
    const run = (s: number, e: number) => ({ start: s, end: e });
    const aids = (extra: Partial<AidRuns>): AidRuns => ({ ...none, ...extra });
    const traces = new Map<number, TraceFacts>([
      [1, { aids: aids({ lockup: [run(310, 312)], abs: [run(310, 340)], wheelspin: [run(120, 125)], tc: [run(120, 140)] }), corner_times_s: [5, 6] }],
      [2, { aids: aids({ lockup: [run(320, 322)], abs: [run(310, 340)], wheelspin: [run(130, 135)], tc: [run(120, 140)] }), corner_times_s: [5, 6.5] }],
    ]);
    const laps = [1, 2].map((n) => ({ lap_id: `l${n}`, lap_no: n, kind: "flying" as const, lap_time_s: 100 + n, valid: true, has_trace: true }));
    const r = buildSessionReport(input(null, { traces, laps }));
    expect(kinds(r)).toEqual(expect.arrayContaining(["lockups", "wheelspins", "abs_activation", "tc_activation"]));
    const lock = r.events.find((e) => e.kind === "lockups")!;
    expect(lock).toMatchObject({ corner: { name: "Beta" }, distance_m: 350, numbers: { n_laps: 2, runs: 2 }, coincides: { scope: "corner", lost_s: 0.5 } });
    expect(lock.sentence).toContain("Beta");
    expect(r.unavailable.map((u) => u.category)).not.toContain("driving");
  });

  it("reports an ABS trend across the flying laps", () => {
    const aid = new Map([1, 2, 3, 4].map((n) => [n, { abs_m: 100 + n * 30, tc_m: 50 }] as const));
    const traces = new Map<number, TraceFacts>([1, 2, 3, 4].map((n) => [n, { aids: none, corner_times_s: [5, 6] }]));
    const laps = [1, 2, 3, 4].map((n) => ({ lap_id: `l${n}`, lap_no: n, kind: "flying" as const, lap_time_s: 100, valid: true, has_trace: true }));
    const e = buildSessionReport(input(null, { aid_activation: aid, traces, laps })).events.find((x) => x.kind === "abs_trend")!;
    expect(e.numbers).toMatchObject({ first_m: 130, last_m: 220 });
  });

  it("reports in-car setting changes with before and after, and the setting values on each lap", () => {
    const stats = [1, 2, 3].map((n) => stat(n));
    const settings = { initial: { TCLevel: 6 }, events: [{ setting: "TCLevel" as const, value: 4, previous: 6, lap_no: 2, dist_m: 150 }] };
    const traces = new Map([[2, { aids: none, corner_times_s: [5, 6] }]]);
    const r = buildSessionReport(input(stats, { settings, traces }));
    const e = r.events.find((x) => x.category === "settings")!;
    expect(e).toMatchObject({ lap_from: 2, numbers: { before: 6, after: 4, distance_m: 150 }, corner: { name: "Alpha" }, distance_m: 150 });
    expect(e.sentence).toBe("TC was changed in the car from 6 to 4 in lap 2.");
    expect(r.laps.map((l) => l.settings?.TCLevel)).toEqual([6, 4, 4]);
  });

  it("reports fall-off (fuel-corrected when the class has a constant), pit laps and invalid laps", () => {
    const stats = [stat(0, { kind: "out", time: 130 }), ...[1, 2, 3, 4, 5].map((n) => stat(n, { time: 100 + n * 0.5 })), stat(6, { kind: "in", time: 200 })];
    stats[3] = { ...stats[3], valid: false, lap_time_s: 0 };
    const r = buildSessionReport(input(stats));
    const fall = r.events.find((e) => e.kind === "pace_falloff")!;
    expect(fall.numbers.slope_s_per_lap).toBeGreaterThan(0.5);
    expect(fall.numbers.raw_slope_s_per_lap).toBeCloseTo(0.5, 1);
    expect(fall.sentence).toContain("with the fuel burnt taken out");
    expect(r.events.find((e) => e.kind === "pit_laps")!.numbers).toMatchObject({ out_laps: 1, in_laps: 1 });
    expect(r.events.find((e) => e.kind === "invalid_laps")!.numbers.n_laps).toBe(1);
  });

  it("reports track temperature drift and which of fuel or energy limits the stint", () => {
    const stats = [1, 2, 3, 4].map((n) => stat(n, { track_temp_c: 30 + n, energy_start_pct: 100 - n * 20, energy_end_pct: 80 - n * 20 }));
    const r = buildSessionReport(input(stats));
    expect(r.events.find((e) => e.kind === "track_temp_drift")!.numbers.change_c).toBe(3);
    const lim = r.events.find((e) => e.category === "conditions" && e.kind.endsWith("_limit"))!;
    expect(lim.kind).toBe("energy_limit");
  });

  describe("without stint stats", () => {
    const laps: ReportLapInput[] = [1, 2, 3, 4].map((n) => ({ lap_id: `l${n}`, lap_no: n, kind: "flying", lap_time_s: 100 + n, valid: true, has_trace: false }));
    it("still reports timing events and lists the categories it could not judge", () => {
      const r = buildSessionReport(input(null, {}, laps));
      expect(r.unavailable.map((u) => u.category)).toEqual(["tyres", "brakes", "conditions", "driving", "settings"]);
      expect(r.unavailable[0].reason).toMatch(/stint stats/);
      expect(kinds(r)).toEqual(["pace_falloff"]);
      expect(r.events[0].numbers.slope_s_per_lap).toBe(1);
      expect(r.laps[0].tyre_surface_c).toBeNull();
    });
  });

  it("marks tyres and brakes unavailable for a class without windows", () => {
    const r = buildSessionReport(input([1, 2].map((n) => stat(n)), { car_class: "Prototype" }));
    expect(r.unavailable.filter((u) => u.reason.includes("windows")).map((u) => u.category)).toEqual(["tyres", "brakes"]);
    expect(r.windows).toEqual([]);
  });

  it("returns the windows it used with their source", () => {
    const r = buildSessionReport(input([stat(1)]));
    expect(r.windows.find((x) => x.key === "tyre_surface_c")).toMatchObject({ min: GT3_WINDOWS.tyre_surface_c.min, unit: "°C" });
    expect(r.windows.every((x) => x.source.length > 0)).toBe(true);
  });
});
