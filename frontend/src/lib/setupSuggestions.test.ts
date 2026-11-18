/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { CarSetup, ReportEvent, ReportLap, SessionReport, Stint, StintLap, Wheels } from "../api/types";
import { createMockApi } from "../api/mock/mockApi";
import { GT3_WINDOWS, windowList } from "./reportWindows";
import { buildSuggestions, innerMinusOuter, MAX_SUGGESTIONS, suggestEnabled, SUGGEST, type Suggestion, type SuggestionSet } from "./setupSuggestions";

const w = (v: number): Wheels => ({ fl: v, fr: v, rl: v, rr: v });

/** A timed lap inside every GT3 window; `over` replaces fields. */
const rlap = (n: number, over: Partial<ReportLap> = {}): ReportLap => ({
  lap_id: `l${n}`, lap_no: n, kind: "flying", lap_time_s: 100 + n, valid: true, has_trace: true,
  tyre_surface_c: { front: 85, rear: 82 }, tyre_carcass_c: { front: 84, rear: 80 }, tyre_pressure_kpa: { front: 172, rear: 168 },
  brake_c: { front: 420, rear: 340 }, track_temp_c: 30, fuel_end_l: 40, energy_end_pct: null, settings: null, ...over,
});
const report = (laps: ReportLap[], events: ReportEvent[] = []): SessionReport => ({
  session_id: "s", car_class: "GT3", compound: "dry (medium)", laps, events, windows: windowList(GT3_WINDOWS), unavailable: [],
});
const SETUP: CarSetup = {
  entries: Object.entries({
    "WM_PRESSURE-W_FL": "136 kPa", "WM_PRESSURE-W_FR": "136 kPa", "WM_PRESSURE-W_RL": "136 kPa", "WM_PRESSURE-W_RR": "136 kPa",
    "WM_CAMBER-W_FL": "-2.20 deg", "WM_CAMBER-W_FR": "-2.20 deg", "WM_CAMBER-W_RL": "-1.90 deg", "WM_CAMBER-W_RR": "-1.90 deg",
    VM_BRAKE_DUCTS: "Open", VM_BRAKE_DUCTS_REAR: "Open", VM_BRAKE_BALANCE: "52.2:47.8", VM_ANTILOCK_BRAKES: "Available",
    VM_ANTILOCKBRAKESYSTEMMAP: "6 (Balanced)", VM_TRACTIONCONTROLMAP: "6", VM_TRACTIONCONTROLPOWERCUTMAP: "6", VM_TRACTIONCONTROLSLIPANGLEMAP: "6",
  }).map(([key, value]) => ({ key, label: key, value })),
};
/** A stint lap whose inner edges run `inner` °C hotter than the outer ones (car frame: inner is right on FL/RL, left on FR/RR). */
const slap = (n: number, innerF: number, innerR: number): StintLap => ({
  lap_id: `l${n}`, lap_no: n, kind: "flying", lap_time_s: 100 + n, valid: true, fuel_start_l: 40, fuel_end_l: 37, energy_start_pct: null, energy_end_pct: null,
  tyre_surface_c: w(85), tyre_zones_c: { left: { fl: 80, fr: 80 + innerF, rl: 80, rr: 80 + innerR }, centre: w(85), right: { fl: 80 + innerF, fr: 80, rl: 80 + innerR, rr: 80 } },
  tyre_carcass_c: w(82), tyre_pressure_kpa: w(170), tyre_wear_end_pct: w(95), brake_c: w(400), track_temp_c: 30, air_temp_c: 20,
});
const stints = (innerF: number, innerR: number): Stint[] => [{ stint_no: 1, laps: [1, 2, 3, 4].map((n) => slap(n, innerF, innerR)), falloff: null, falloff_fuel_corrected: null }];
const four = (over: Partial<ReportLap> = {}) => [1, 2, 3, 4].map((n) => rlap(n, over));
const aidEvent = (kind: string, corner: string, avg: number, lost: number): ReportEvent => ({
  id: `${kind}-${corner}`, category: "driving", kind, severity: "info", lap_from: 1, lap_to: 4, corner: { id: corner, name: corner }, distance_m: 100,
  numbers: { avg_m: avg, n_laps: 4, n_traced: 4, lap_from: 1, lap_to: 4, lost_s: lost }, coincides: { scope: "corner", lost_s: lost, laps: [1, 2, 3, 4] }, sentence: "",
});

/** Every number in a suggestion's title and reason (corner name removed) must be in its numbers; considered reasons likewise. */
function strayNumbers(text: string, numbers: Record<string, number>, corner: string | null = null): string[] {
  const t = corner ? text.replaceAll(corner, "") : text;
  return (t.match(/\d+(\.\d+)?/g) ?? []).filter((tok) => {
    const d = tok.includes(".") ? tok.split(".")[1].length : 0;
    return !Object.values(numbers).some((v) => Math.abs(v).toFixed(d) === tok);
  });
}
function expectGuarded(set: SuggestionSet) {
  for (const s of [...set.suggestions, ...set.more, ...set.observations]) expect(strayNumbers(`${s.title}. ${s.reason}`, s.numbers, s.corner), s.id).toEqual([]);
  for (const c of set.considered) expect(strayNumbers(c.reason, c.numbers), c.label).toEqual([]);
}
const ids = (xs: Suggestion[]) => xs.map((s) => s.id);

describe("setup suggestions (experimental, vroom-k5s.2)", () => {
  it("suggests nothing when everything is inside its window, and says why for each item", () => {
    const set = buildSuggestions(report(four()), SETUP, stints(10, 9));
    expect(set.suggestions).toEqual([]);
    expect(set.considered.map((c) => c.label)).toEqual([
      "Front tyre pressure", "Rear tyre pressure", "Front brake ducts", "Rear brake ducts", "Front camber", "Rear camber", "ABS level", "TC level", "Brake balance (52.2:47.8)",
    ]);
    expectGuarded(set);
  });

  it("turns a hot pressure gap into a cold change with this session's gas-law ratio, shown as an observation", () => {
    const set = buildSuggestions(report(four({ tyre_pressure_kpa: { front: 182, rear: 168 } })), SETUP, stints(10, 9));
    expect(set.suggestions).toEqual([]);
    expect(ids(set.observations)).toEqual(["pressure-front"]);
    const s = set.observations[0];
    // Window middle 171.85; gap 10.15 hot; ratio (182 + 101.3) / (136 + 101.3) = 1.19; 10.15 / 1.19 = 8.5 -> 9 kPa cold.
    expect(s.numbers.ratio).toBe(1.19);
    expect(s.numbers.step).toBe(9);
    expect(s.title).toBe("Lower front cold pressure by about 9 kPa");
    expect(s.current).toBe("136 kPa");
    expect(s.confidence).toBe("medium"); // the GT3 pressure window is measured from the driver's laps
    expectGuarded(set);
  });

  it("leaves a pressure alone within the window's tolerance", () => {
    const set = buildSuggestions(report(four({ tyre_pressure_kpa: { front: 176, rear: 168 } })), SETUP, stints(10, 9)); // 1.7 kPa over, tolerance 3
    expect(set.suggestions).toEqual([]);
    expect(set.observations).toEqual([]);
  });

  it("uses the hot gap as is when the session has no setup", () => {
    const set = buildSuggestions(report(four({ tyre_pressure_kpa: { front: 172, rear: 160 } })), { entries: [] }, stints(10, 9));
    const s = set.observations.find((x) => x.id === "pressure-rear")!;
    expect(s.current).toBeNull();
    expect(s.title).toBe("Raise rear cold pressure by about 8 kPa");
    expectGuarded(set);
  });

  it("closes a cold axle's ducts, and does not open ducts that are already open", () => {
    const cold = buildSuggestions(report(four({ brake_c: { front: 360, rear: 340 } })), SETUP, stints(10, 9));
    expect(cold.observations.map((s) => s.title)).toEqual(["Close the front brake ducts one step"]);
    const hot = buildSuggestions(report(four({ brake_c: { front: 500, rear: 340 } })), SETUP, stints(10, 9));
    expect(hot.observations).toEqual([]);
    expect(hot.considered.find((c) => c.label === "Front brake ducts")!.reason).toMatch(/already Open/);
    expectGuarded(cold);
    expectGuarded(hot);
  });

  it("reads camber from the inner edge in the car frame", () => {
    expect(innerMinusOuter(slap(1, 10, 4), "front")).toBe(10);
    expect(innerMinusOuter(slap(1, 10, 4), "rear")).toBe(4);
    const set = buildSuggestions(report(four()), SETUP, stints(10, 4));
    expect(set.observations.map((s) => [s.title, s.confidence])).toEqual([["More negative rear camber, one step", "low"]]);
    expect(buildSuggestions(report(four()), SETUP, stints(15, 9)).observations[0].title).toBe("Less negative front camber, one step");
  });

  it("proposes one aid test, the larger loss first, and only from the threshold up", () => {
    const events = [aidEvent("abs_activation", "Bus Stop", 39, 0.11), aidEvent("tc_activation", "Fagnes 2", 16, 0.24)];
    const set = buildSuggestions(report(four(), events), SETUP, stints(10, 9));
    expect(set.suggestions.map((s) => [s.title, s.kind])).toEqual([["Try TC 5 instead of 6 for one run", "experiment"]]);
    expect(set.considered.find((c) => c.label === "ABS level")!.reason).toMatch(/one aid test at a time/);
    expectGuarded(set);
    const small = buildSuggestions(report(four(), [aidEvent("abs_activation", "La Source", 38, SUGGEST.aidMinLostS - 0.05)]), SETUP, stints(10, 9));
    expect(small.suggestions).toEqual([]);
  });

  it("puts an in-car setting kept to the end into the garage, with high confidence, first", () => {
    const laps = four({ brake_c: { front: 360, rear: 290 } }).map((l, i) => ({ ...l, settings: { TCLevel: i < 2 ? 6 : 4, ABSLevel: 6 } }));
    const set = buildSuggestions(report(laps), SETUP, stints(10, 9));
    expect(ids(set.suggestions)).toEqual(["kept-TCLevel"]);
    expect(set.suggestions[0]).toMatchObject({ confidence: "high", title: "Set TC 4 in the garage" });
    expect(ids(set.observations)).toEqual(["ducts-front", "ducts-rear"]); // cold discs: an observation, not a change
    expect(set.more).toEqual([]);
    expectGuarded(set);
  });

  it("reads ?suggest", () => {
    expect(suggestEnabled("?suggest")).toBe(true);
    expect(suggestEnabled("?suggest=1")).toBe(true);
    expect(suggestEnabled("?suggest=0")).toBe(false);
    expect(suggestEnabled("?balance")).toBe(false);
  });
});

describe("setup suggestions on the mock sessions", () => {
  const read = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../public/mock/${n}`, import.meta.url)), "utf8"));
  const api = createMockApi({
    coachDelayMs: 0, loadSpa: async () => read("spa-2026-11-03.json"), loadMonza: async () => read("monza-2026-11-05.json"), loadSpaRace: async () => read("spa-race-2026-11-10.json"),
    loadSpaRaceStint: async () => read("spa-race-stint-2026-11-10.json"), loadStint: async () => read("monza-stint-2026-11-09.json"),
  });
  const forSession = async (startsWith: string) => {
    const s = (await api.sessions()).find((x) => x.started_at.startsWith(startsWith))!;
    return buildSuggestions(await api.sessionReport(s.session_id), await api.sessionSetup(s.session_id), await api.sessionStints(s.session_id));
  };

  it("Spa race (10 Nov): no change; pressures, discs and camber are in range and the ABS / TC losses are too small", async () => {
    const set = await forSession("2026-11-10");
    expect(set.suggestions).toEqual([]);
    expect(set.observations).toEqual([]);
    const reasons = Object.fromEntries(set.considered.map((c) => [c.label, c.reason]));
    expect(reasons["Front tyre pressure"]).toMatch(/^Hot pressure averaged 173\.1 kPa over 4 timed laps, inside/);
    expect(reasons["Front camber"]).toMatch(/11\.2 °C hotter/);
    expect(reasons["Rear camber"]).toMatch(/8\.9 °C hotter/);
    expect(reasons["TC level"]).toMatch(/0\.10 s or more/);
    expectGuarded(set);
  });

  it("Monza practice (5 Nov): one TC test at Parabolica", async () => {
    const set = await forSession("2026-11-05");
    expect(set.suggestions.map((s) => [s.title, s.corner])).toEqual([["Try TC 4 instead of 5 for one run", "Parabolica"]]);
    expectGuarded(set);
  });

  it("every session: at most two, every number guarded", async () => {
    for (const s of await api.sessions()) {
      const set = buildSuggestions(await api.sessionReport(s.session_id), await api.sessionSetup(s.session_id), await api.sessionStints(s.session_id));
      expect(set.suggestions.length).toBeLessThanOrEqual(MAX_SUGGESTIONS);
      expectGuarded(set);
    }
  });
});
