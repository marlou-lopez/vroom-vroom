/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ApiError, REPORT_CATEGORIES, type ReportEvent, type SessionMeta } from "../types";
import { CLASS_WINDOWS } from "../../lib/reportWindows";
import { createMockApi } from "./mockApi";

const read = (n: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/mock/${n}`, import.meta.url)), "utf8"));
const files = {
  spa: read("spa-2026-11-03.json"), monza: read("monza-2026-11-05.json"), race: read("spa-race-2026-11-10.json"),
  raceStint: read("spa-race-stint-2026-11-10.json"), monzaStint: read("monza-stint-2026-11-09.json"),
};
const engine = () => createMockApi({
  coachDelayMs: 0, loadSpa: async () => files.spa, loadMonza: async () => files.monza, loadSpaRace: async () => files.race,
  loadSpaRaceStint: async () => files.raceStint, loadStint: async () => files.monzaStint,
});

/** Every number in the sentence (corner name removed) must be in the event's numbers, at the sentence's precision. */
function strayNumbers(e: ReportEvent): string[] {
  const text = e.corner ? e.sentence.replace(e.corner.name, "") : e.sentence;
  const allowed = Object.values(e.numbers);
  return (text.match(/\d+(\.\d+)?/g) ?? []).filter((tok) => {
    const d = tok.includes(".") ? tok.split(".")[1].length : 0;
    return !allowed.some((v) => v.toFixed(d) === tok);
  });
}

describe("session report (mock, vroom-bi4.11)", () => {
  it("is served for every mock session", async () => {
    const api = engine();
    const all = await api.sessions();
    expect(all.length).toBe(8);
    for (const s of all) {
      const r = await api.sessionReport(s.session_id);
      expect(r.session_id).toBe(s.session_id);
      expect(r.laps.length).toBe((await api.sessionLaps(s.session_id)).length);
      expect(r.windows.length).toBeGreaterThan(0);
      expect(CLASS_WINDOWS[s.car_class]).toBeDefined();
    }
    await expect(api.sessionReport("nope")).rejects.toBeInstanceOf(ApiError);
  });

  it("has an event in tyres, brakes, driving, settings and pace on the Spa race, each with laps, numbers and a sentence", async () => {
    const api = engine();
    const race = (await api.sessions()).find((s) => s.started_at.startsWith("2026-11-10"))!;
    const r = await api.sessionReport(race.session_id);
    expect(r.unavailable).toEqual([]);
    for (const c of ["tyres", "brakes", "driving", "settings", "pace"] as const) {
      const e = r.events.filter((x) => x.category === c);
      expect(e.length, c).toBeGreaterThan(0);
      for (const x of e) {
        expect(x.lap_from).toBeLessThanOrEqual(x.lap_to);
        expect(Object.keys(x.numbers).length).toBeGreaterThan(0);
        expect(x.sentence.length).toBeGreaterThan(10);
      }
    }
    // Driving and setting events have a place on a traced lap and carry corner and distance. Lap-level events (tyres, brakes, pace) carry
    // the corner that lost most only when the laps are timed and a corner lost time, so they may have none.
    for (const x of r.events.filter((e) => e.category === "driving" && e.kind !== "abs_trend" && e.kind !== "tc_trend")) {
      expect(x.corner, x.sentence).not.toBeNull();
      expect(x.distance_m).not.toBeNull();
    }
    const setting = r.events.find((e) => e.category === "settings")!;
    expect(setting.distance_m).toBe(6885);
    expect(r.laps.map((l) => l.settings?.TCLevel)).toEqual(Array(9).fill(6));
    expect(r.laps[1].tyre_surface_c!.front).toBeGreaterThan(0);
  });

  it("states every number in an event's numbers, avoids causes, tyre load, grip and brake bias, for every session", async () => {
    const api = engine();
    let n = 0;
    for (const s of await api.sessions()) {
      for (const e of (await api.sessionReport(s.session_id)).events) {
        n++;
        expect(strayNumbers(e), e.sentence).toEqual([]);
        expect(e.sentence).not.toMatch(/because/i);
        expect(e.sentence).not.toMatch(/tyre load|tire load|grip|brake bias/i);
        if (e.coincides) expect(e.sentence).toContain("coincides with");
      }
    }
    expect(n).toBeGreaterThan(30);
  });

  it("gives the Monza race (no traces) a timing and stint report and names what it cannot judge", async () => {
    const api = engine();
    const monza = (await api.sessions()).find((s) => s.started_at.startsWith("2026-11-09")) as SessionMeta;
    const r = await api.sessionReport(monza.session_id);
    expect(r.unavailable.map((u) => u.category).sort()).toEqual(["driving", "settings"]);
    expect(r.events.some((e) => e.category === "tyres")).toBe(true);
    expect(r.events.every((e) => e.corner === null && e.distance_m === null)).toBe(true);
  });

  it("lists the categories a session without stint stats could not judge", async () => {
    const api = engine();
    const practice = (await api.sessions()).find((s) => s.started_at.startsWith("2026-11-03"))!;
    const r = await api.sessionReport(practice.session_id);
    expect(r.unavailable.map((u) => u.category)).toEqual(["tyres", "brakes", "conditions", "settings"]);
    expect(r.laps.every((l) => l.tyre_surface_c === null)).toBe(true);
    expect(REPORT_CATEGORIES.length).toBe(6);
  });
});
