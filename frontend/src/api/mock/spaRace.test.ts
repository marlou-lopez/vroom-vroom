/// <reference types="node" />
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockApi } from "./mockApi";
import type { Recording } from "./recording";
import type { StintFile } from "./stint";

const path = (name: string) => fileURLToPath(new URL(`../../../public/mock/${name}`, import.meta.url));
const read = <T,>(name: string) => JSON.parse(readFileSync(path(name), "utf8")) as T;
const SPA = read<Recording>("spa-2026-11-03.json");
const MONZA = read<Recording>("monza-2026-11-05.json");
const RACE = read<Recording>("spa-race-2026-11-10.json");
const STINT = read<StintFile>("spa-race-stint-2026-11-10.json");
const engine = () =>
  createMockApi({
    coachDelayMs: 0, loadSpa: async () => SPA, loadMonza: async () => MONZA,
    loadSpaRace: async () => RACE, loadSpaRaceStint: async () => STINT,
  });
const raceSession = async (api = engine()) => (await api.sessions()).find((s) => s.started_at.startsWith("2026-11-10"))!;

describe("Spa race of 10 Nov 2026 (mock)", () => {
  it("is a Race session next to the existing Spa and Monza sessions", async () => {
    const api = engine();
    const all = await api.sessions();
    expect(all.length).toBe(7);
    const s = (await raceSession(api))!;
    expect(s).toMatchObject({ track_name: "Spa-Francorchamps", session_type: "Race", car_class: "GT3", driver: "Driver" });
    expect(all.filter((x) => x.track_name === "Monza").length).toBe(2);
  });

  it("has a lap with a trace for every recorded lap, and the lap rail data adds up", async () => {
    const api = engine();
    const s = await raceSession(api);
    const laps = await api.sessionLaps(s.session_id);
    expect(laps.map((l) => l.lap_no)).toEqual(RACE.laps.map((l) => l.lap_no));
    expect(laps.every((l) => l.has_trace)).toBe(true);
    expect(laps.map((l) => l.kind)).toEqual(["out", "flying", "flying", "flying", "flying", "flying", "in", "out", "incomplete"].map((k) => k));
    expect(laps[2].valid).toBe(false);
    const sum = await api.sessionSummary(s.session_id);
    expect(sum.n_laps).toBe(9);
    expect(sum.n_valid).toBe(4);
  });

  it("loads every lap's trace and compares it against another lap", async () => {
    const api = engine();
    const s = await raceSession(api);
    const laps = await api.sessionLaps(s.session_id);
    const ref = laps[3];
    for (const lap of laps) {
      const tr = await api.lapTrace(lap.lap_id);
      expect(tr.distance.length).toBe(RACE.laps[lap.lap_no].length_m + 1);
      const cmp = await api.compare(lap.lap_id, ref.lap_id);
      expect(cmp.ref_lap_id).toBe(ref.lap_id);
      expect(cmp.lap_id).toBe(lap.lap_id);
      expect(cmp.delta.length).toBeGreaterThan(0);
    }
  });

  it("serves its stints with per-lap stats: one stop splits the race in two", async () => {
    const api = engine();
    const s = await raceSession(api);
    const stints = await api.sessionStints(s.session_id);
    expect(stints.map((x) => x.laps.map((l) => l.lap_no))).toEqual([[0, 1, 2, 3, 4, 5, 6], [7, 8]]);
    const lap1 = stints[0].laps[1];
    expect(lap1.fuel_start_l).toBeGreaterThan(lap1.fuel_end_l);
    expect(lap1.tyre_pressure_kpa).not.toBeNull();
    expect(lap1.brake_c).not.toBeNull();
    const laps = await api.sessionLaps(s.session_id);
    expect(stints.flatMap((x) => x.laps.map((l) => l.lap_id))).toEqual(laps.map((l) => l.lap_id));
  });

  it("serves the recording's setup", async () => {
    const api = engine();
    const { entries } = await api.sessionSetup((await raceSession(api)).session_id);
    expect(entries).toHaveLength(Object.keys(RACE.car_setup!).length);
    expect(entries.find((e) => e.key === "VM_STEER_LOCK")?.value).toBe("524deg (18.5deg)");
  });
});

describe("setting events and aid activation in the Spa race file", () => {
  it("has the initial settings and the six TCLevel changes of the pit stop, with lap and distance", () => {
    expect(RACE.initial_settings).toEqual({ ABSLevel: 6, TCLevel: 6, TCCut: 6, TCSlipAngle: 6, FuelMixtureMap: 1 });
    const ev = RACE.setting_events!;
    expect(ev).toHaveLength(6);
    for (const e of ev) {
      expect(e.setting).toBe("TCLevel");
      expect(e.lap_no).toBe(6); // the in lap
      expect(e.dist_m).toBeGreaterThan(6000);
      expect([5, 6]).toContain(e.value);
      expect(e.value).not.toBe(e.previous);
    }
    expect(ev.map((e) => e.lap_time_s)).toEqual([...ev.map((e) => e.lap_time_s)].sort((a, b) => a - b));
  });

  it("counts ABS and TC metres and activations per lap from the lap's own grid", () => {
    for (const lap of RACE.laps) {
      const a = lap.aid_activation!;
      expect(a.abs_m).toBe(lap.abs!.reduce((x, y) => x + y, 0));
      expect(a.tc_m).toBe(lap.tc!.reduce((x, y) => x + y, 0));
      expect(a.abs_runs).toBeLessThanOrEqual(a.abs_m);
      expect(a.tc_runs).toBeLessThanOrEqual(a.tc_m);
    }
    expect(RACE.laps[3].aid_activation!.abs_m).toBeGreaterThan(100);
  });
});

describe("Spa race files", () => {
  it("are under 50 MB each and carry no driver or account name", () => {
    for (const f of ["spa-race-2026-11-10.json", "spa-race-stint-2026-11-10.json"]) {
      expect(statSync(path(f)).size).toBeLessThan(50 * 1024 * 1024);
      expect(readFileSync(path(f), "utf8")).not.toMatch(/marlou|lopez|steam|@/i);
    }
  });
});
