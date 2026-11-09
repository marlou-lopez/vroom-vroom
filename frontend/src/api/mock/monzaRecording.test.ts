/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createMockApi } from "./mockApi";
import { monzaCorners, MONZA_TRACK_ID, MONZA_TRACK_LENGTH_M } from "./monzaTrack";
import type { Recording } from "./recording";

const FILE = fileURLToPath(new URL("../../../public/mock/monza-2026-11-05.json", import.meta.url));
const REC = JSON.parse(readFileSync(FILE, "utf8")) as Recording;
const REF = REC.laps.find((l) => l.lap_no === 6)!;
const api = () => createMockApi({ coachDelayMs: 0, loadMonza: async () => REC });

describe("Monza recording data", () => {
  it("holds the lap numbers the mock session refers to, each on a 1 m grid of Monza's length", () => {
    expect(REC.laps.map((l) => l.lap_no)).toEqual([0, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    for (const l of REC.laps) {
      expect(l.length_m, `lap ${l.lap_no}`).toBeGreaterThanOrEqual(MONZA_TRACK_LENGTH_M - 5);
      expect(l.length_m, `lap ${l.lap_no}`).toBeLessThanOrEqual(MONZA_TRACK_LENGTH_M + 5);
      for (const key of ["t", "speed_kmh", "throttle", "brake", "steering", "gear", "rpm", "g_lat", "g_long", "lat", "lon", "path_lateral", "track_edge", "kerb"] as const) {
        expect(l[key], `lap ${l.lap_no} ${key}`).toHaveLength(l.length_m + 1);
      }
    }
  });

  it("has the recorded lap times: timed flying laps, two invalid or pit laps with time 0, none for the out laps", () => {
    const time = (n: number) => REC.laps.find((l) => l.lap_no === n)!.lap_time_s;
    expect([5, 6, 9, 10, 11, 12].map(time)).toEqual([113.202, 112.308, 115.643, 112.722, 112.842, 112.348]);
    expect([7, 13].map(time)).toEqual([0, 0]);
    expect([0, 8].map(time)).toEqual([null, null]);
  });

  it("does not carry the driver's name or the setup", () => {
    const text = readFileSync(FILE, "utf8");
    expect(text).not.toMatch(/driver|steam|setup/i);
    expect(Object.keys(REC).sort()).toEqual(["laps", "source", "steering_range_deg"]);
  });

  // Speed minima on the reference lap, the way the corner list was made. Curva Grande is flat out (no minimum) and Ascari 3 is
  // the chicane's exit, where the speed barely dips: those two come from the lateral-g and steering peaks instead.
  it("puts every other corner on a speed minimum of the reference lap", () => {
    const speed = REF.speed_kmh;
    for (const c of monzaCorners(REF)) {
      if (c.id === "curvagrande" || c.id === "ascari3") continue;
      const window = speed.slice(c.apex_m - 15, c.apex_m + 16);
      expect(speed[c.apex_m], c.name).toBeLessThanOrEqual(Math.min(...window) + 1);
    }
  });

  it("puts the Ascari 3 apex on the steering peak of the left-hand exit", () => {
    const c = monzaCorners(REF).find((x) => x.id === "ascari3")!;
    const window = REF.steering.slice(c.apex_m - 15, c.apex_m + 16);
    expect(REF.steering[c.apex_m]).toBeLessThan(-0.1); // left
    expect(REF.steering[c.apex_m]).toBeLessThanOrEqual(Math.min(...window) + 0.03);
  });

  it("puts the Curva Grande apex in the middle of the flat-out right-hander", () => {
    const c = monzaCorners(REF).find((x) => x.id === "curvagrande")!;
    expect(REF.throttle.slice(c.start_m, c.end_m + 1).every((v) => v >= 0.95)).toBe(true);
    expect(REF.steering[c.apex_m]).toBeGreaterThan(0); // right
  });
});

describe("Monza in the mock API", () => {
  it("serves two Monza sessions built from the real laps, and no Spa ones when only Monza is loaded", async () => {
    const sessions = await api().sessions();
    expect(sessions.map((s) => s.track_id)).toEqual([MONZA_TRACK_ID, MONZA_TRACK_ID]);
    const main = sessions.find((s) => s.car_name.includes("720S"))!;
    expect(main.track_name).toBe("Monza");
    expect(main.track_length_m).toBe(MONZA_TRACK_LENGTH_M);
    expect(main.steering_range_deg).toBe(REC.steering_range_deg);
  });

  it("lists the recorded laps with their own lap times and a valid-flying-lap reference of 1:52.308", async () => {
    const a = api();
    const main = (await a.sessions()).find((s) => s.car_name.includes("720S"))!;
    const laps = await a.sessionLaps(main.session_id);
    expect(laps.map((l) => l.kind)).toEqual(["out", "flying", "flying", "in", "out", "flying", "flying", "flying", "flying", "in"]);
    expect(laps.filter((l) => l.kind === "flying").map((l) => l.lap_time_s)).toEqual([113.202, 112.308, 115.643, 112.722, 112.842, 112.348]);
    const ref = laps.filter((l) => l.is_reference);
    expect(ref).toHaveLength(1);
    expect(ref[0].lap_time_s).toBe(112.308);
  });

  it("draws the map from the recording: the real corner names, landmarks, and the same corners as monzaCorners", async () => {
    const map = await (async () => { const a = api(); await a.sessions(); return a.trackMap(MONZA_TRACK_ID); })();
    expect(map.length_m).toBe(MONZA_TRACK_LENGTH_M);
    expect(map.corners).toEqual(monzaCorners(REF));
    expect(map.corners.every((c) => !c.approx)).toBe(true);
    expect(new Set(map.corners.map((c) => c.complex ?? c.name))).toEqual(
      new Set(["Rettifilo", "Curva Grande", "Roggia", "Lesmo 1", "Lesmo 2", "Ascari", "Parabolica"]),
    );
    expect(map.landmarks.some((l) => l.kind === "brake_board")).toBe(true);
    for (const c of map.corners) {
      expect(c.start_m, c.id).toBeLessThan(c.apex_m);
      expect(c.end_m, c.id).toBeGreaterThan(c.apex_m);
      expect(c.end_m, c.id).toBeLessThanOrEqual(MONZA_TRACK_LENGTH_M);
    }
  });

  it("compares two real Monza laps on the recording's grid", async () => {
    const a = api();
    const main = (await a.sessions()).find((s) => s.car_name.includes("720S"))!;
    const laps = await a.sessionLaps(main.session_id);
    const cmp = await a.compare(laps[1].lap_id); // lap 5 against the reference (lap 6)
    expect(cmp.ref_lap_id).toBe(laps[2].lap_id);
    expect(cmp.distance.length).toBeGreaterThan(5700);
    expect(cmp.delta[cmp.delta.length - 1]).toBeCloseTo(113.202 - 112.308, 1);
    expect(cmp.elevation).toBeNull();
    expect(cmp.track_survey).toBeNull();
  });
});
