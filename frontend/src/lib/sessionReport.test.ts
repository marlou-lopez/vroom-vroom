import { describe, expect, it } from "vitest";
import type { Corner, LapKind, StintLap, Wheels } from "../api/types";
import type { AidRuns } from "./driverAids";
import { GT3_WINDOWS, rangeFor } from "./reportWindows";
import { buildSessionReport, type ReportInput, type ReportLapInput, type TraceFacts } from "./sessionReport";
import { splitStints } from "../api/mock/stint";

const w = (v: number): Wheels => ({ fl: v, fr: v, rl: v, rr: v });
const CORNERS: Corner[] = [
  { id: "c1", name: "Alpha", start_m: 100, apex_m: 150, end_m: 200, complex: null, approx: false },
  { id: "c2", name: "Beta", start_m: 300, apex_m: 350, end_m: 400, complex: null, approx: false },
];
const BRAKE: Wheels = { fl: 420, fr: 420, rl: 340, rr: 340 }; // inside the GT3 window and ratio (1.24)
const none: AidRuns = { abs: [], tc: [], lockup: [], wheelspin: [] };

function stat(n: number, o: Partial<StintLap> & { kind?: LapKind; time?: number } = {}): StintLap {
  return {
    lap_id: `l${n}`, lap_no: n, kind: o.kind ?? "flying", lap_time_s: o.time ?? 100, valid: true,
    fuel_start_l: 40 - n * 2, fuel_end_l: 38 - n * 2, energy_start_pct: null, energy_end_pct: null,
    tyre_surface_c: w(90), tyre_zones_c: { left: w(90), centre: w(90), right: w(90) }, tyre_carcass_c: w(82), tyre_pressure_kpa: w(170),
    tyre_wear_end_pct: w(100 - n), brake_c: BRAKE, track_temp_c: 30, air_temp_c: 20, ...o,
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
    expect(r.unavailable.map((u) => u.category)).toEqual(["tyres", "brakes", "driving", "settings"]); // 4 laps: too few to compare with the best laps
    expect(r.laps[0].tyre_surface_c).toEqual({ front: 90, rear: 90 });
  });

  it("flags tyre temperature below and above the window per axle, and pressure", () => {
    const cold = (n: number) => stat(n, { tyre_surface_c: { fl: 90, fr: 90, rl: 70, rr: 72 }, tyre_pressure_kpa: { fl: 190, fr: 190, rl: 170, rr: 170 }, tyre_carcass_c: { fl: 82, fr: 82, rl: 82, rr: 82 } });
    const r = buildSessionReport(input([1, 2, 3].map(cold)));
    expect(kinds(r)).toEqual(["tyre_surface_c_low", "tyre_pressure_kpa_high"]);
    const low = r.events[0];
    expect(low).toMatchObject({ category: "tyres", lap_from: 1, lap_to: 3, numbers: { mean: 71, window_min: 80, n_laps: 3 } });
    expect(low.sentence).toContain("Rear tyre surface temperature averaged 71.0 °C");
    const hot = buildSessionReport(input([1, 2].map((n) => stat(n, { tyre_carcass_c: w(120) }))));
    expect(kinds(hot)).toEqual(["tyre_carcass_c_high", "tyre_carcass_c_high"]); // front and rear
  });

  describe("window tolerance and per-axle windows (vroom-bi4.13)", () => {
    const tol = GT3_WINDOWS.tyre_pressure_kpa.tolerance; // 3 kPa
    const rear = rangeFor(GT3_WINDOWS.tyre_pressure_kpa, "rear"), front = rangeFor(GT3_WINDOWS.tyre_pressure_kpa, "front");
    // Rear pressure p kPa, front pressure inside its own window, on n laps.
    const rearP = (p: number, n = 3) => buildSessionReport(input(Array.from({ length: n }, (_, i) => stat(i + 1, { tyre_pressure_kpa: { fl: 171, fr: 171, rl: p, rr: p } }))));
    it("stays quiet within the tolerance of the window edge, fires just outside it", () => {
      expect(kinds(rearP(rear.min - tol))).toEqual([]); // exactly the tolerance below: inside
      expect(kinds(rearP(rear.min - tol + 0.5))).toEqual([]);
      const e = rearP(rear.min - tol - 0.5).events[0];
      expect(e).toMatchObject({ kind: "tyre_pressure_kpa_low", severity: expect.not.stringMatching(/problem/) });
      expect(e.numbers).toMatchObject({ window_min: rear.min, window_max: rear.max });
    });
    it("needs at least twice the tolerance for a problem", () => {
      expect(rearP(rear.min - 2 * tol + 0.2).events[0].severity).not.toBe("problem"); // 1.9x: a watch at most
      expect(rearP(rear.min - 2 * tol - 0.2).events[0].severity).toBe("problem"); // all laps outside, more than twice
    });
    it("judges front and rear against their own range", () => {
      const both = (p: number) => buildSessionReport(input([1, 2, 3].map((n) => stat(n, { tyre_pressure_kpa: w(p) }))));
      expect(kinds(both(front.min - tol - 0.5))).toEqual(["tyre_pressure_kpa_low"]); // 165.9: only the front is low
      expect(both(front.min - tol - 0.5).events[0].sentence).toContain("Front tyre pressure");
      expect(kinds(both(rear.max + tol + 0.5)).length).toBe(1); // 173.6: the rear is high, the front is inside its 174.3
      expect(both(rear.max + tol + 0.5).events[0].sentence).toContain("Rear tyre pressure");
    });
    it("keeps the published tyre surface window for both axles, with the tolerance", () => {
      expect("min" in GT3_WINDOWS.tyre_surface_c && GT3_WINDOWS.tyre_surface_c.min).toBe(80);
      const surface = (t: number) => kinds(buildSessionReport(input([1, 2, 3].map((n) => stat(n, { tyre_surface_c: w(t) })))));
      expect(surface(77)).toEqual([]); // 3 °C below the published 80: inside the tolerance
      expect(surface(76.9)).toEqual(["tyre_surface_c_low", "tyre_surface_c_low"]); // front and rear
    });
    it("applies the tolerance to spread, brake temperature and the brake ratio", () => {
      const zones = (d: number) => ({ left: w(90 + d / 2), centre: w(90), right: w(90 - d / 2) });
      const spread = (d: number) => buildSessionReport(input([1, 2, 3].map((n) => stat(n, { tyre_zones_c: zones(d) }))));
      expect(kinds(spread(11))).toEqual([]); // rear window 9.2 + 2 = 11.2, front 11.3 + 2 = 13.3
      expect(spread(12).events.map((e) => e.sentence.slice(0, 4))).toEqual(["Rear"]);
      expect(kinds(spread(13.5))).toEqual(["tyre_spread", "tyre_spread"]);
      const brake = (f: number, rr: number) => kinds(buildSessionReport(input([1, 2, 3].map((n) => stat(n, { brake_c: { fl: f, fr: f, rl: rr, rr } })))));
      expect(brake(478, 370)).toEqual([]); // front window 389-468, tolerance 10
      expect(brake(479, 370)).toContain("brake_high");
      expect(brake(420, 320)).toEqual([]); // ratio 1.3125: 1.27 + 0.05 = 1.32
      expect(brake(420, 315)).toEqual(["brake_imbalance_high"]); // 1.333
    });
  });

  it("needs two laps for a tyre event and ignores out laps for a cold value", () => {
    const cold = { tyre_surface_c: w(60) };
    expect(kinds(buildSessionReport(input([stat(1, { kind: "out", ...cold }), stat(2, cold), stat(3)])))).toEqual(["pit_laps"]);
  });

  it("reports discs cooling on the out lap after a stop, and does not judge in laps", () => {
    const stats = [stat(1), stat(2), stat(3, { kind: "in", brake_c: w(150), tyre_pressure_kpa: w(100) }), stat(4, { kind: "out", brake_c: { fl: 300, fr: 300, rl: 250, rr: 250 } })];
    const r = buildSessionReport(input(stats));
    expect(kinds(r)).toEqual(["pit_laps", "brake_pit_cooling"]);
    expect(r.events[1].numbers).toMatchObject({ front_c: 300, rear_c: 250, front_before_c: 420, rear_before_c: 340 });
  });

  describe("vs your best laps", () => {
    // 10 flying laps, best set = 2 fastest rounded up to 3; laps 6-9 run 8 C hotter at the rear (surface and carcass) and 0.4 s slower.
    const laps = (hotRear: (n: number) => boolean, hotBrake = false) => [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => {
      const hot = hotRear(n);
      return stat(n, {
        time: hot ? 100.4 + n * 0.01 : 100 + n * 0.01,
        tyre_surface_c: { fl: 90, fr: 90, rl: hot ? 92 : 84, rr: hot ? 92 : 84 }, tyre_carcass_c: w(82),
        ...(hotBrake && hot ? { brake_c: { fl: 480, fr: 480, rl: 340, rr: 340 } } : {}),
      });
    });
    const vs = (r: ReturnType<typeof buildSessionReport>) => r.events.filter((e) => e.kind.startsWith("vs_best_"));

    it("reports a hotter axle on laps that lost time, with the amount, best-lap count and coincidence", () => {
      const r = buildSessionReport(input(laps((n) => n >= 6 && n <= 9)));
      const e = vs(r);
      expect(e.map((x) => x.kind)).toEqual(["vs_best_tyre_surface_c_high"]);
      expect(e[0]).toMatchObject({ category: "tyres", lap_from: 6, lap_to: 9, numbers: { diff: 8, n_laps: 4, n_best: 3 } });
      expect(e[0].sentence).toContain("Rear tyre surface temperature ran 8.0 °C hotter than on your 3 best laps, on 4 laps (laps 6 to 9).");
      expect(e[0].coincides).toMatchObject({ scope: "lap" });
      expect(e[0].sentence).toContain("coincides with");
      expect(e[0].sentence).not.toMatch(/because|grip|load|bias/i);
      expect(r.unavailable.map((u) => u.category)).not.toContain("tyres");
    });

    it("covers brake discs", () => {
      const e = vs(buildSessionReport(input(laps((n) => n >= 6 && n <= 9, true))));
      expect(e.some((x) => x.category === "brakes" && x.kind === "vs_best_brake_c_high")).toBe(true);
    });

    it("stays quiet when the hotter laps did not lose time", () => {
      // The hotter laps' times are within 0.05 s of the best lap: no coincidence, no event.
      const s = laps((n) => n >= 6 && n <= 9).map((l) => ({ ...l, lap_time_s: 100 + l.lap_no * 0.001 }));
      expect(vs(buildSessionReport(input(s)))).toEqual([]);
    });

    it("skips with a note when there are too few timed flying laps", () => {
      const r = buildSessionReport(input(laps((n) => n >= 3).slice(0, 4)));
      expect(vs(r)).toEqual([]);
      expect(r.unavailable.filter((u) => /best laps/.test(u.reason)).map((u) => u.category)).toEqual(["tyres", "brakes"]);
      expect(r.unavailable[0].reason).toContain("(4, need at least 5)");
    });
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
    expect(kinds(r)).toEqual(expect.arrayContaining(["lockups", "wheelspins", "abs_activation"]));
    const lock = r.events.find((e) => e.kind === "lockups")!;
    expect(lock).toMatchObject({ corner: { name: "Beta" }, distance_m: 350, numbers: { n_laps: 2, runs: 2 }, coincides: { scope: "corner", lost_s: 0.5 } });
    expect(lock.sentence).toContain("Beta");
    expect(r.unavailable.map((u) => u.category)).not.toContain("driving");
    // TC at Alpha lost no time there and there are too few laps to compare with the best laps: a bare description, so it is dropped (vroom-bi4.13).
    expect(kinds(r)).not.toContain("tc_activation");
  });

  it("keeps an ABS activation that differs from the best laps without time lost, drops a smaller difference (vroom-bi4.13)", () => {
    const run = (m: number) => ({ start: 300, end: 300 + m - 1 });
    // 5 timed flying laps, equal corner times (nothing lost); laps 1 to 3 are the best set.
    const build = (best: number, other: number) => {
      const traces = new Map<number, TraceFacts>([1, 2, 3, 4, 5].map((n) => [n, { aids: { ...none, abs: [run(n <= 3 ? best : other)] }, corner_times_s: [5, 6] }]));
      const laps = [1, 2, 3, 4, 5].map((n) => ({ lap_id: `l${n}`, lap_no: n, kind: "flying" as const, lap_time_s: 100 + n * 0.001, valid: true, has_trace: true }));
      return buildSessionReport(input(null, { traces, laps })).events.find((e) => e.kind === "abs_activation");
    };
    const e = build(40, 20)!; // best 40 m, others 20 m: 20 m and 50 % apart
    expect(e.coincides).toBeNull();
    expect(e.numbers).toMatchObject({ best_m: 40, others_m: 20, n_best: 3 });
    expect(e.sentence).toContain("On your 3 best laps it was 40 m");
    expect(build(40, 36)).toBeUndefined(); // 4 m apart: under aidBestDiffM
    expect(build(100, 80)).toBeUndefined(); // 20 m apart but only 20 %: under aidBestDiffShare
  });

  describe("lock-up and wheelspin trend per corner", () => {
    /** Nine flying laps; `perLap[n-1]` is the number of lock-ups in Beta (c2) on lap n, wheelspin in Alpha (c1) when `kind` is wheelspin. */
    const session = (perLap: number[], kind: "lockup" | "wheelspin" = "lockup", beta = (n: number) => 6 + n * 0.1) => {
      const at = kind === "lockup" ? 310 : 110;
      const traces = new Map<number, TraceFacts>(perLap.map((k, i) => [i + 1, {
        aids: { ...none, [kind]: Array.from({ length: k }, (_, j) => ({ start: at + j * 20, end: at + j * 20 + 2 })) }, corner_times_s: [5, beta(i + 1)],
      }]));
      const laps = perLap.map((_, i) => ({ lap_id: `l${i + 1}`, lap_no: i + 1, kind: "flying" as const, lap_time_s: 100 + i, valid: true, has_trace: true }));
      return buildSessionReport(input(null, { traces, laps }));
    };
    const trend = (r: ReturnType<typeof buildSessionReport>, kind = "lockup_trend") => r.events.filter((e) => e.kind === kind);

    it("reports a rising lock-up count in a corner, with the corner and the time lost on those laps", () => {
      const r = session([0, 0, 0, 1, 1, 1, 2, 2, 2]);
      const [e] = trend(r);
      expect(trend(r)).toHaveLength(1);
      expect(e).toMatchObject({
        category: "driving", corner: { name: "Beta" }, distance_m: 350, lap_from: 7, lap_to: 9,
        numbers: { first_runs: 0, last_runs: 6, n_window: 3, first_lap_from: 1, first_lap_to: 3, last_lap_from: 7, last_lap_to: 9 },
        coincides: { scope: "corner", lost_s: 0.7 },
      });
      expect(e.sentence).toBe("Lock-ups at Beta rose from 0 in the first 3 flying laps (laps 1 to 3) to 6 in the last 3 (laps 7 to 9). It coincides with 0.70 s lost in that corner on those laps.");
      expect(e.sentence).not.toMatch(/because|grip|load|bias/i);
    });

    it("reports a falling count, pointing at the early laps where it happened", () => {
      const [e] = trend(session([2, 2, 2, 1, 0, 0, 0, 0, 0]));
      expect(e.sentence).toContain("Lock-ups at Beta fell from 6");
      expect(e).toMatchObject({ lap_from: 1, lap_to: 3, numbers: { first_runs: 6, last_runs: 0 } });
    });

    it("reports wheelspin the same way", () => {
      const r = session([0, 0, 0, 0, 0, 0, 2, 2, 2], "wheelspin");
      expect(trend(r, "wheelspin_trend")[0]).toMatchObject({ corner: { name: "Alpha" }, numbers: { last_runs: 6 } });
      expect(trend(r)).toHaveLength(0);
    });

    it("reports nothing when the count is flat", () => {
      expect(trend(session([1, 1, 1, 1, 1, 1, 1, 1, 1]))).toHaveLength(0);
      expect(trend(session([2, 0, 1, 1, 1, 1, 0, 2, 1]))).toHaveLength(0);
    });

    it("reports nothing below the minimum count or change, or with too few laps", () => {
      expect(trend(session([0, 0, 0, 0, 0, 0, 1, 1, 0]))).toHaveLength(0); // 2 runs: under cornerTrendMinCount
      expect(trend(session([2, 1, 0, 1, 1, 1, 2, 1, 1]))).toHaveLength(0); // 3 against 4: change under cornerTrendMinChange
      expect(trend(session([0, 0, 0, 3, 3]))).toHaveLength(0); // five laps
    });

    it("leaves out and in laps out of the thirds", () => {
      const counts = [0, 0, 0, 1, 1, 1, 2, 2, 2];
      const traces = new Map<number, TraceFacts>(counts.map((k, i) => [i + 1, { aids: { ...none, lockup: Array.from({ length: k }, (_, j) => ({ start: 310 + j * 20, end: 312 + j * 20 })) }, corner_times_s: [5, 6] }]));
      const laps = counts.map((_, i) => ({ lap_id: `l${i + 1}`, lap_no: i + 1, kind: i === 8 ? ("in" as const) : ("flying" as const), lap_time_s: 100, valid: true, has_trace: true }));
      const [e] = buildSessionReport(input(null, { traces, laps })).events.filter((x) => x.kind === "lockup_trend");
      expect(e.numbers).toMatchObject({ n_window: 2, last_lap_from: 7, last_lap_to: 8, last_runs: 4 });
    });
  });

  it("reports an ABS trend across the flying laps", () => {
    const trend = (nums: number[]) => {
      const aid = new Map(nums.map((n) => [n, { abs_m: 100 + n * 30, tc_m: 50 }] as const));
      const traces = new Map<number, TraceFacts>(nums.map((n) => [n, { aids: none, corner_times_s: [5, 6] }]));
      const laps = nums.map((n) => ({ lap_id: `l${n}`, lap_no: n, kind: "flying" as const, lap_time_s: 100, valid: true, has_trace: true }));
      return buildSessionReport(input(null, { aid_activation: aid, traces, laps })).events.find((x) => x.kind === "abs_trend");
    };
    expect(trend([1, 2, 3, 4, 5, 6])!.numbers).toMatchObject({ first_m: 130, last_m: 280 });
    expect(trend([1, 2, 3, 4, 5])).toBeUndefined(); // a trend needs at least 6 flying laps (vroom-bi4.13)
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
    expect(r.windows.find((x) => x.key === "tyre_surface_c")).toMatchObject({ min: 80, max: 100, unit: "°C", axle: "both", tolerance: 3 });
    expect(r.windows.filter((x) => x.key === "tyre_pressure_kpa").map((x) => [x.axle, x.min, x.max])).toEqual([["front", 169.4, 174.3], ["rear", 166.3, 170.1]]);
    expect(r.windows.every((x) => x.source.length > 0)).toBe(true);
  });
});
