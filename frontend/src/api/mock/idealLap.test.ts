/// <reference types="node" />
// Ideal lap (#91, part 1): IdealLap from the mock, real sector times, and the contract over HTTP.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRealApi } from "../client";
import { ApiError, effectiveValid, idealRefId, idealRefSession } from "../types";
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

describe("segment times (vroom-bi4.2)", () => {
  it("lines up with the ideal lap's segments, adds up to each lap's time, and the ideal holds the minima", async () => {
    for (const day of ["2026-11-03", "2026-11-05"]) {
      const s = await sessionOf(day);
      const ideal = await engine.idealLap(s.session_id);
      const { laps } = await engine.segmentTimes(s.session_id);
      const meta = await engine.sessionLaps(s.session_id);
      expect(laps.length).toBeGreaterThan(1);
      for (const l of laps) {
        expect(l.segment_s).toHaveLength(ideal.segments.length);
        expect(Math.abs(sum(l.segment_s) - meta.find((m) => m.lap_id === l.lap_id)!.lap_time_s!)).toBeLessThan(0.02);
        l.segment_s.forEach((t, k) => expect(t).toBeGreaterThanOrEqual(ideal.segments[k].best_s - 0.0011));
      }
      ideal.segments.forEach((seg, k) => expect(laps.find((l) => l.lap_id === seg.lap_id)!.segment_s[k]).toBeCloseTo(seg.best_s, 3));
    }
  });

  it("is served over HTTP, and an unknown session is an ApiError", async () => {
    const s = await sessionOf("2026-11-03");
    expect(await http.segmentTimes(s.session_id)).toEqual(await engine.segmentTimes(s.session_id));
    expect((await rejection(http.segmentTimes("nope"))).code).toBe("unknown_session");
  });
});

describe("compare against the ideal lap (vroom-bi4.3)", () => {
  it("names the ideal by the reserved ref id ideal:<session_id>", () => {
    expect(idealRefId("abc")).toBe("ideal:abc");
    expect(idealRefSession("ideal:abc")).toBe("abc");
    expect(idealRefSession("abc")).toBeNull();
  });

  it("gives a delta that ends at lap time minus ideal time, on every Spa and Monza lap", async () => {
    for (const day of ["2026-11-03", "2026-11-05"]) {
      const s = await sessionOf(day);
      const ideal = await engine.idealLap(s.session_id);
      const laps = (await engine.sessionLaps(s.session_id)).filter((l) => l.kind === "flying" && effectiveValid(l) && (l.lap_time_s ?? 0) > 0);
      expect(laps.length).toBeGreaterThan(1);
      for (const lap of laps) {
        const cmp = await engine.compare(lap.lap_id, idealRefId(s.session_id));
        expect(cmp.ref_lap_id).toBe(idealRefId(s.session_id));
        expect(cmp.ref_kind).toBe("flying");
        expect(cmp.warning).toBeNull();
        const end = cmp.delta[cmp.delta.length - 1];
        expect(Math.abs(end - (lap.lap_time_s! - ideal.time_s))).toBeLessThan(0.02);
        expect(cmp.ref.t[0]).toBe(0);
        // The stitched clock never runs backwards.
        cmp.ref.t.forEach((t, i) => { if (i > 0) expect(t).toBeGreaterThanOrEqual(cmp.ref.t[i - 1]); });
      }
    }
  });

  it("lists the joins at the segment starts after the first, and a real lap has none", async () => {
    const s = await sessionOf("2026-11-03");
    const ideal = await engine.idealLap(s.session_id);
    const lap = (await engine.sessionLaps(s.session_id)).find((l) => l.kind === "flying" && effectiveValid(l))!;
    const cmp = await engine.compare(lap.lap_id, idealRefId(s.session_id));
    expect(cmp.ref_joins_m).toEqual(ideal.segments.slice(1).map((x) => x.start_m).filter((m) => m < cmp.distance.length));
    expect(cmp.ref_joins_m.length).toBeGreaterThan(5);
    const real = await engine.compare(lap.lap_id);
    expect(real.ref_joins_m).toEqual([]);
  });

  it("takes each segment's channels from the lap that holds it", async () => {
    const s = await sessionOf("2026-11-03");
    const ideal = await engine.idealLap(s.session_id);
    const lap = (await engine.sessionLaps(s.session_id)).find((l) => l.kind === "flying" && effectiveValid(l))!;
    const cmp = await engine.compare(lap.lap_id, idealRefId(s.session_id));
    for (const seg of ideal.segments) {
      const mid = Math.floor((seg.start_m + seg.end_m) / 2);
      if (mid >= cmp.distance.length) continue;
      const src = await engine.lapTrace(seg.lap_id, ["speed_kmh"]);
      expect(cmp.ref.speed_kmh[mid]).toBe(src.ch.speed_kmh![mid]);
    }
  });

  it("offers the ideal as the first candidate, only for a lap with valid laps in its own session", async () => {
    const s = await sessionOf("2026-11-03");
    const lap = (await engine.sessionLaps(s.session_id)).find((l) => l.kind === "flying" && effectiveValid(l))!;
    const cands = await engine.compareCandidates(lap.lap_id);
    expect(cands[0]).toMatchObject({ lap_id: idealRefId(s.session_id), is_ideal: true, other_car: false });
    expect(cands[0].lap_time_s).toBe((await engine.idealLap(s.session_id)).time_s);
    expect(cands[0].label).toContain("Ideal lap (session)");
    expect(cands.filter((c) => c.is_ideal)).toHaveLength(1);
  });

  it("compares only against the lap's own session's ideal", async () => {
    const spa = await sessionOf("2026-11-03");
    const monza = await sessionOf("2026-11-05");
    const lap = (await engine.sessionLaps(spa.session_id)).find((l) => l.kind === "flying" && effectiveValid(l))!;
    expect((await rejection(engine.compare(lap.lap_id, idealRefId(monza.session_id)))).code).toBe("unknown_lap");
    expect((await rejection(engine.compare(lap.lap_id, "ideal:nope"))).code).toBe("unknown_lap");
  });

  it("runs the coach against the ideal and files the result under the ideal's ref id", async () => {
    const s = await sessionOf("2026-11-03");
    const ref = idealRefId(s.session_id);
    const lap = (await engine.sessionLaps(s.session_id)).find((l) => l.kind === "flying" && effectiveValid(l))!;
    const res = await engine.coach({ command: "analyze", lap_id: lap.lap_id, ref_lap_id: ref, corner_id: null });
    expect(res.ref_lap_id).toBe(ref);
    expect((await engine.coachResults(lap.lap_id, ref)).analyze?.id).toBe(res.id);
  });

  it("is served over HTTP with the ref id in the query", async () => {
    const s = await sessionOf("2026-11-03");
    const lap = (await engine.sessionLaps(s.session_id)).find((l) => l.kind === "flying" && effectiveValid(l))!;
    const cmp = await http.compare(lap.lap_id, idealRefId(s.session_id));
    expect(cmp.ref_lap_id).toBe(idealRefId(s.session_id));
    expect(cmp.ref_joins_m.length).toBeGreaterThan(5);
    expect((await http.compareCandidates(lap.lap_id))[0].is_ideal).toBe(true);
  });
});

describe("ideal lap comparison edge cases (vroom-bi4.3 review)", () => {
  it("an out lap has no shortfall correction, and marking a lap invalid rebuilds the ideal", async () => {
    const s = await sessionOf("2026-11-03");
    const ref = idealRefId(s.session_id);
    const laps = await engine.sessionLaps(s.session_id);
    const out = laps.find((l) => l.kind === "out")!;
    const cmp = await engine.compare(out.lap_id, ref);
    expect(Math.abs(cmp.delta[cmp.delta.length - 1])).toBeLessThan(60); // not minus the whole lap time
    const best = laps.filter((l) => l.kind === "flying" && effectiveValid(l)).sort((a, b) => a.lap_time_s! - b.lap_time_s!)[0];
    const other = laps.find((l) => l.kind === "flying" && effectiveValid(l) && l.lap_id !== best.lap_id)!;
    const before = (await engine.compareCandidates(other.lap_id))[0].lap_time_s;
    await engine.patchLap(best.lap_id, { valid_override: false });
    const after = (await engine.compareCandidates(other.lap_id))[0].lap_time_s;
    expect(after).toBe((await engine.idealLap(s.session_id)).time_s);
    expect(after).not.toBe(before);
    const c2 = await engine.compare(other.lap_id, ref);
    expect(Math.abs(c2.delta[c2.delta.length - 1] - (other.lap_time_s! - after!))).toBeLessThan(0.02);
    await engine.patchLap(best.lap_id, { valid_override: null });
  });
});
