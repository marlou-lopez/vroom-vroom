/// <reference types="node" />
// Ideal lap (#91, part 1): IdealLap from the mock, real sector times, and the contract over HTTP.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRealApi } from "../client";
import { ApiError, effectiveValid } from "../types";
import { createHandlers } from "./handlers";
import { createMockApi } from "./mockApi";
import type { Recording } from "./recording";

const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/mock/${f}`, import.meta.url)), "utf8")) as Recording;
const SPA = read("spa-2026-11-03.json");
const MONZA = read("monza-2026-11-05.json");
const engine = createMockApi({ coachDelayMs: 0, loadSpa: async () => SPA, loadMonza: async () => MONZA });

const server = setupServer(...createHandlers(engine));
const http = createRealApi("http://localhost");
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

async function sessionOf(startsWith: string) {
  return (await engine.sessions()).find((s) => s.started_at.startsWith(startsWith))!;
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

describe("ideal lap", () => {
  it("is the sum of the segment minima, never above the best valid lap, and tiles the track", async () => {
    for (const day of ["2026-11-03", "2026-11-05"]) {
      const s = await sessionOf(day);
      const ideal = await engine.idealLap(s.session_id);
      const laps = await engine.sessionLaps(s.session_id);
      const timed = laps.filter((l) => l.kind === "flying" && effectiveValid(l) && (l.lap_time_s ?? 0) > 0);
      const best = Math.min(...timed.map((l) => l.lap_time_s!));
      expect(ideal.scope).toBe("session");
      expect(ideal.time_s).toBeLessThanOrEqual(best);
      expect(ideal.time_s).toBeGreaterThan(best - 3); // a few tenths, not seconds, from the best lap
      expect(Math.abs(ideal.time_s - sum(ideal.segments.map((x) => x.best_s)))).toBeLessThan(0.01);
      expect(ideal.segments[0].start_m).toBe(0);
      ideal.segments.forEach((x, i) => {
        if (i > 0) expect(x.start_m).toBe(ideal.segments[i - 1].end_m);
        expect(x.end_m).toBeGreaterThan(x.start_m);
      });
      for (const seg of ideal.segments) {
        const owner = laps.find((l) => l.lap_id === seg.lap_id)!;
        expect(owner.lap_no).toBe(seg.lap_no);
        expect(timed.map((l) => l.lap_id)).toContain(owner.lap_id);
        expect(seg.session_id).toBe(s.session_id);
      }
      const summary = await engine.sessionSummary(s.session_id);
      expect(summary.theoretical_best_s).toBe(ideal.time_s);
    }
  });

  it("never takes a segment from an invalid, out or in lap, and drops a lap marked invalid by hand", async () => {
    const s = await sessionOf("2026-11-03");
    const laps = await engine.sessionLaps(s.session_id);
    const bad = new Set(laps.filter((l) => l.kind !== "flying" || !effectiveValid(l)).map((l) => l.lap_id));
    expect(bad.size).toBeGreaterThan(2); // out lap, in lap and the invalid lap 5
    const ideal = await engine.idealLap(s.session_id);
    for (const seg of ideal.segments) expect(bad.has(seg.lap_id)).toBe(false);
    const winner = ideal.segments[0].lap_id;
    await engine.patchLap(winner, { valid_override: false });
    const after = await engine.idealLap(s.session_id);
    expect(after.segments.every((x) => x.lap_id !== winner)).toBe(true);
    expect(after.time_s).toBeGreaterThanOrEqual(ideal.time_s);
    await engine.patchLap(winner, { valid_override: null });
    expect((await engine.idealLap(s.session_id)).time_s).toBe(ideal.time_s);
  });

  it("names corners and the straights between them", async () => {
    const s = await sessionOf("2026-11-03");
    const map = await engine.trackMap(s.track_id);
    const ideal = await engine.idealLap(s.session_id);
    const corners = ideal.segments.filter((x) => x.corner_id !== null);
    expect(corners.length).toBe(map.corners.length);
    for (const c of corners) {
      const corner = map.corners.find((m) => m.id === c.corner_id)!;
      expect([c.label, c.start_m, c.end_m]).toEqual([corner.name, corner.start_m, corner.end_m]);
    }
    const straight = ideal.segments.find((x) => x.corner_id === null)!;
    expect(straight.label).toContain("→");
  });

  it("scope=all takes the best segments over every session of the track and car, and is never slower", async () => {
    const s = await sessionOf("2026-11-03");
    const own = await engine.idealLap(s.session_id, "session");
    const all = await engine.idealLap(s.session_id, "all");
    expect(all.scope).toBe("all");
    expect(all.time_s).toBeLessThanOrEqual(own.time_s);
    expect(all.segments).toHaveLength(own.segments.length);
    all.segments.forEach((x, k) => expect(x.best_s).toBeLessThanOrEqual(own.segments[k].best_s));
    const sessions = await engine.sessions();
    const sameTrackCar = new Set(sessions.filter((x) => x.track_id === s.track_id && x.car_id === s.car_id).map((x) => x.session_id));
    for (const seg of all.segments) expect(sameTrackCar.has(seg.session_id)).toBe(true);
    const porsche = sessions.find((x) => x.track_id === s.track_id && x.car_id !== s.car_id)!;
    expect(all.segments.some((x) => x.session_id === porsche.session_id)).toBe(false);
  });

  it("a lap's segments against the ideal's add up to lap time minus ideal time (where a compare delta ends)", async () => {
    const s = await sessionOf("2026-11-03");
    const ideal = await engine.idealLap(s.session_id);
    const flying = (await engine.sessionLaps(s.session_id)).filter((l) => l.kind === "flying" && effectiveValid(l));
    expect(flying.length).toBe(4);
    for (const lap of flying) {
      const t = (await engine.lapTrace(lap.lap_id, ["t"])).ch.t!;
      const scale = lap.lap_time_s! / (t[t.length - 1] - t[0]);
      const lost = sum(ideal.segments.map((x) => (t[Math.min(x.end_m, t.length - 1)] - t[x.start_m]) * scale - x.best_s));
      expect(Math.abs(lost - (lap.lap_time_s! - ideal.time_s))).toBeLessThan(0.02);
    }
  });

  it("rejects an unknown session, and a session with no valid flying lap", async () => {
    expect((await rejection(engine.idealLap("nope"))).code).toBe("unknown_session");
    const s = await sessionOf("2026-11-03");
    const laps = await engine.sessionLaps(s.session_id);
    for (const l of laps) await engine.patchLap(l.lap_id, { valid_override: false });
    expect((await rejection(engine.idealLap(s.session_id))).code).toBe("no_valid_laps");
    expect((await engine.sessionSummary(s.session_id)).theoretical_best_s).toBeNull();
    for (const l of laps) await engine.patchLap(l.lap_id, { valid_override: null });
  });
});

describe("real sector times", () => {
  it("Spa serves the recorded sectors, adding up to the lap time", async () => {
    const s = await sessionOf("2026-11-03");
    const laps = await engine.sessionLaps(s.session_id);
    for (const no of [1, 2, 3, 4]) {
      const lap = laps.find((l) => l.lap_no === no)!;
      const rec = SPA.laps.find((l) => l.lap_no === no)!;
      expect(lap.sectors_s).toEqual(rec.sectors_s);
      expect(lap.sectors_s).toHaveLength(3);
      expect(Math.abs(sum(lap.sectors_s) - lap.lap_time_s!)).toBeLessThan(0.01);
    }
    // Lap 4's sector 1 is 38.267 s in the recording's Last Sector1 event, not 28 % of the lap.
    expect(laps.find((l) => l.lap_no === 4)!.sectors_s[0]).toBeCloseTo(38.267, 3);
  });

  it("serves no sectors on an invalid lap, an out lap or an in lap", async () => {
    const s = await sessionOf("2026-11-03");
    const laps = await engine.sessionLaps(s.session_id);
    for (const no of [0, 5, 6]) expect(laps.find((l) => l.lap_no === no)!.sectors_s).toEqual([]);
  });

  it("a re-timed lap's sectors still add up to its time", async () => {
    const s = await sessionOf("2026-11-01");
    const laps = (await engine.sessionLaps(s.session_id)).filter((l) => l.kind === "flying");
    expect(laps.length).toBeGreaterThan(0);
    for (const lap of laps) {
      expect(lap.sectors_s).toHaveLength(3);
      expect(Math.abs(sum(lap.sectors_s) - lap.lap_time_s!)).toBeLessThan(0.01);
    }
  });

  it("Monza serves the recorded sectors on its timed laps only", async () => {
    const s = await sessionOf("2026-11-05");
    const laps = await engine.sessionLaps(s.session_id);
    const timed = laps.filter((l) => l.kind === "flying" && effectiveValid(l) && (l.lap_time_s ?? 0) > 0);
    expect(timed.length).toBeGreaterThan(3);
    for (const lap of timed) expect(Math.abs(sum(lap.sectors_s) - lap.lap_time_s!)).toBeLessThan(0.01);
    for (const lap of laps.filter((l) => !timed.includes(l))) expect(lap.sectors_s).toEqual([]);
  });

  it("every recorded lap's sectors in the data files add up to its lap time", () => {
    for (const rec of [SPA, MONZA]) {
      for (const lap of rec.laps) {
        if (lap.sectors_s) {
          expect(lap.lap_time_s).toBeGreaterThan(0);
          expect(Math.abs(sum(lap.sectors_s) - lap.lap_time_s!)).toBeLessThan(0.01);
        } else {
          expect(lap.sectors_s ?? null).toBeNull();
        }
      }
    }
  });
});

describe("GET /api/sessions/{id}/ideal over MSW", () => {
  it("defaults to scope=session and takes scope=all", async () => {
    const s = await sessionOf("2026-11-03");
    const direct = await engine.idealLap(s.session_id);
    expect(await http.idealLap(s.session_id)).toEqual(direct);
    expect(await http.idealLap(s.session_id, "session")).toEqual(direct);
    expect(await http.idealLap(s.session_id, "all")).toEqual(await engine.idealLap(s.session_id, "all"));
  });

  it("maps errors: unknown session is 404, a bad scope 422", async () => {
    expect((await rejection(http.idealLap("nope"))).code).toBe("unknown_session");
    const s = await sessionOf("2026-11-03");
    const res = await fetch(`http://localhost/api/sessions/${s.session_id}/ideal?scope=week`);
    expect(res.status).toBe(422);
    expect((await res.json()).code).toBe("invalid_scope");
  });
});
