/// <reference types="node" />
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Api } from "../client";
import { ApiError, type CoachResult, type Corner, type LapWithRef, type SessionMeta } from "../types";
import { spread, steeringCorrections, steeringExtrema } from "./coachFacts";
import { createMockApi } from "./mockApi";
import type { SpaRecording } from "./recording";
import { makeSpaLap } from "./spa";
import { brakeOnset, deriveLandmarks, kerbRuns, spaCorners } from "./spaTrack";

const round3 = (x: number) => Number(x.toFixed(3));
/** The user's real recording, read from disk (the app fetches the same file from /mock). */
const RECORDING = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../public/mock/spa-2026-11-03.json", import.meta.url)), "utf8"),
) as SpaRecording;
const loadSpa = async () => RECORDING;
const recLap = (no: number) => RECORDING.laps.find((l) => l.lap_no === no)!;
const METRE_CUE = /\b\d+(\.\d+)?\s?(m|metres|meters)\b/;
const TRACK = "spa-francorchamps-grand-prix";

async function setup() {
  const api: Api = createMockApi({ coachDelayMs: 0, loadSpa });
  const sessions = await api.sessions();
  const spaNov3 = sessions.find((s) => s.track_id === TRACK && s.started_at.startsWith("2026-11-03"))!;
  const laps = await api.sessionLaps(spaNov3.session_id);
  const lap = (n: number) => laps.find((l) => l.lap_no === n)!;
  return { api, sessions, spaNov3, laps, lap };
}

async function rejection(p: Promise<unknown>): Promise<ApiError> {
  try {
    await p;
  } catch (e) {
    return e as ApiError;
  }
  throw new Error("expected rejection");
}

describe("makeSpaLap (synthetic, still behind the Monza session)", () => {
  it("7004-point 1 m grid, strictly increasing t, final t == lap time", () => {
    const lap = makeSpaLap({ lapTimeS: 142.91, variant: "ref" });
    expect(lap.distance).toHaveLength(7004);
    const t = lap.ch.t;
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);
    expect(Math.abs(t[t.length - 1] - 142.91)).toBeLessThan(0.001);
  });
});

describe("loading", () => {
  it("does not call the loader until the first Api call, then only once", async () => {
    const loader = vi.fn(loadSpa);
    const api = createMockApi({ coachDelayMs: 0, loadSpa: loader });
    expect(loader).not.toHaveBeenCalled();
    const [a] = await Promise.all([api.sessions(), api.sessions()]);
    expect(loader).toHaveBeenCalledTimes(1);
    await api.trackMap(a[0].track_id);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("maps a failed load to a network ApiError and retries on the next call", async () => {
    let n = 0;
    const api = createMockApi({ loadSpa: async () => { if (n++ === 0) throw new Error("offline"); return RECORDING; } });
    expect((await rejection(api.sessions())).code).toBe("network");
    expect((await api.sessions()).length).toBe(5);
  });
});

describe("mockApi: real Spa laps", () => {
  it("3 Nov is the recording exactly: laps 0-6, kinds, validity, steering range, t", async () => {
    const { api, laps, sessions, spaNov3, lap } = await setup();
    expect(laps.map((l) => l.lap_no)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(laps.map((l) => l.kind)).toEqual(["out", "flying", "flying", "flying", "flying", "flying", "in"]);
    // an invalid lap (recorded 0) shows its elapsed time; out/in laps stay null
    expect(laps.map((l) => l.lap_time_s)).toEqual(RECORDING.laps.map((l) => (l.lap_time_s === 0 ? l.t[l.t.length - 1] : l.lap_time_s)));
    expect(lap(5).lap_time_s).toBeCloseTo(168.856, 3);
    expect(lap(5).valid).toBe(false);
    expect(laps.map((l) => l.valid)).toEqual([true, true, true, true, true, false, true]);
    expect(laps.filter((l) => l.is_reference).map((l) => l.lap_no)).toEqual([4]);
    expect(spaNov3.steering_range_deg).toBe(524);
    expect(spaNov3.car_id).toBe("mclaren_720s_gt3_evo");
    expect(spaNov3.track_length_m).toBe(6979);
    expect(sessions.find((s) => s.car_name.includes("Porsche"))!.steering_range_deg).toBeNull();
    // Approximate public dimensions for the 720S; the Porsche race session is unknown (null) to exercise the fallback.
    expect(spaNov3.car_dims).toEqual({ length_m: 4.664, width_m: 2.04, wheelbase_m: 2.696, visual_offset: { forward_m: 0.0745, up_m: -0.3335 } });
    expect(sessions.find((s) => s.car_name.includes("Porsche"))!.car_dims).toBeNull();
    for (const l of laps) {
      const tr = await api.lapTrace(l.lap_id);
      const rec = recLap(l.lap_no);
      expect(tr.distance).toHaveLength(rec.length_m + 1);
      expect(tr.ch.speed_kmh).toEqual(rec.speed_kmh);
      const t = tr.ch.t!;
      expect(t[0]).toBeLessThan(0.05); // the recording's first sample is at ~0.015 s
      for (let i = 1; i < t.length; i++) if (!(t[i] > t[i - 1])) throw new Error(`t not increasing at lap ${l.lap_no} index ${i}`);
      if (l.lap_no >= 1 && l.lap_no <= 4) expect(Math.abs(t[t.length - 1] - l.lap_time_s!)).toBeLessThan(0.05);
    }
  });

  it("other Spa sessions reuse real shapes with scaled times, slower than the 3 Nov best", async () => {
    const { api, sessions } = await setup();
    const others = sessions.filter((s) => s.track_id === TRACK && !s.started_at.startsWith("2026-11-03"));
    expect(others).toHaveLength(3);
    for (const s of others) {
      for (const l of (await api.sessionLaps(s.session_id)).filter((x) => x.kind === "flying")) {
        expect(l.lap_time_s!).toBeGreaterThanOrEqual(142);
        expect(l.lap_time_s!).toBeLessThanOrEqual(144.5);
        const tr = await api.lapTrace(l.lap_id, ["t", "speed_kmh"]);
        expect(tr.ch.t![tr.ch.t!.length - 1]).toBeCloseTo(l.lap_time_s!, 6);
        expect(tr.distance.length).toBeGreaterThan(6900);
      }
    }
    const nov3 = sessions.find((s) => s.started_at.startsWith("2026-11-03"))!;
    const best = (await api.sessionLaps(nov3.session_id)).find((l) => l.is_reference)!;
    expect(best.lap_time_s).toBe(141.525);
  });

  it("compare: delta ends at t_lap(end) - t_ref(end) on the common grid", async () => {
    const { api, lap } = await setup();
    const cmp = await api.compare(lap(1).lap_id, lap(4).lap_id);
    const a = recLap(1);
    const b = recLap(4);
    const n = Math.min(a.length_m, b.length_m);
    expect(cmp.distance).toHaveLength(n + 1);
    expect(cmp.delta).toHaveLength(n + 1);
    expect(cmp.lap.speed_kmh).toHaveLength(n + 1);
    expect(cmp.delta[n]).toBeCloseTo(a.t[n] - b.t[n], 9);
    expect(cmp.lap_id).toBe(lap(1).lap_id);
    expect(cmp.lap_steering_range_deg).toBe(524);
    expect(cmp.lap_car_dims).toEqual({ length_m: 4.664, width_m: 2.04, wheelbase_m: 2.696, visual_offset: { forward_m: 0.0745, up_m: -0.3335 } });
    expect(cmp.lap_car_id).toBe("mclaren_720s_gt3_evo");
    expect(cmp.ref_car_id).toBe("mclaren_720s_gt3_evo");
    expect(cmp.warning).toBeNull();
  });

  it("compare reports the kinds of both laps", async () => {
    const { api, lap } = await setup();
    const cmp = await api.compare(lap(4).lap_id, lap(0).lap_id);
    expect(cmp.lap_kind).toBe("flying");
    expect(cmp.ref_kind).toBe("out");
  });

  it("compare across laps of different length uses 0..min(lenA, lenB)", async () => {
    const { api, lap } = await setup();
    const cmp = await api.compare(lap(6).lap_id, lap(4).lap_id);
    const n = Math.min(recLap(6).length_m, recLap(4).length_m);
    expect(n).toBe(6971);
    expect(cmp.distance).toHaveLength(n + 1);
    expect(cmp.distance[n]).toBe(n);
    expect(cmp.delta[n]).toBeCloseTo(recLap(6).t[n] - recLap(4).t[n], 9);
  });

  it("compare returns the Spa track survey on the grid (null without one or off Spa); a failing loader gives null", async () => {
    const survey = { source: "t", track: null, captures: [], edges: [], kerbs: [], contacts: [[0, 0, "edge"] as [number, number, "edge"]], bank: [] };
    const mk = async (loadSurvey: () => Promise<typeof survey | null>) => {
      const api = createMockApi({ coachDelayMs: 0, loadSpa, loadSurvey });
      const s = (await api.sessions()).find((x) => x.track_id === TRACK && x.started_at.startsWith("2026-11-03"))!;
      const laps = await api.sessionLaps(s.session_id);
      const id = (n: number) => laps.find((l) => l.lap_no === n)!.lap_id;
      return { api, cmp: await api.compare(id(6), id(4)), monza: await api.sessions() };
    };
    const { cmp } = await mk(async () => survey);
    expect(cmp.track_survey!.left_m).toHaveLength(cmp.distance.length);
    expect(cmp.track_survey!.right_m.every((v) => v === null)).toBe(true);
    expect(cmp.track_survey!.bank_deg).toHaveLength(cmp.distance.length);
    expect((await mk(async () => null)).cmp.track_survey).toBeNull();
    expect((await mk(async () => { throw new Error("x"); })).cmp.track_survey).toBeNull();
    // default: with a custom loadSpa and no loadSurvey there is none
    const { api, lap } = await setup();
    expect((await api.compare(lap(4).lap_id, lap(3).lap_id)).track_survey).toBeNull();
  });

  describe("trackGeometry", () => {
    const survey = {
      source: "t", track: null, captures: [], kerbs: [], bank: [],
      contacts: [[0, 0, "edge"] as [number, number, "edge"]],
      edges: [] as [number, number, 0 | 1, number][],
    };
    const elevation = { source: "t", track: null, points: [] as [number, number, number][], laps: [] };

    it("serves the Spa centreline, survey, coverage and the verified local transform on one grid", async () => {
      const api = createMockApi({ coachDelayMs: 0, loadSpa, loadSurvey: async () => survey, loadElevation: async () => elevation });
      const g = await api.trackGeometry(TRACK);
      const n = g.centre.lat.length;
      expect(g.track_id).toBe(TRACK);
      expect(n).toBeGreaterThan(6900);
      expect(g.centre.lon).toHaveLength(n);
      expect(g.survey!.left_m).toHaveLength(n);
      expect(g.survey!.bank_deg).toHaveLength(n);
      expect(g.elevation_m).toHaveLength(n);
      expect(g.coverage).toEqual({ left: 0, right: 0 }); // the stub survey measures nothing
      expect(g.transform.local).toMatchObject({ kind: "equirectangular", origin_lat_deg: 60, origin_lon_deg: 0 });
      expect(g.transform.real_world).toBeNull();
    });

    it("with the real Spa survey and elevation: partial edge coverage, heights present, kerbs found", async () => {
      const read = (f: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`../../../public/mock/${f}`, import.meta.url)), "utf8"));
      const api = createMockApi({
        coachDelayMs: 0, loadSpa, loadSurvey: async () => read("spa-survey-2026-11-06.json"), loadElevation: async () => read("spa-elevation-2026-11-05.json"),
      });
      const g = await api.trackGeometry(TRACK);
      expect(g.coverage!.left).toBeGreaterThan(0.3);
      expect(g.coverage!.left).toBeLessThan(1);
      expect(g.coverage!.right).toBeGreaterThan(0.3);
      expect(g.elevation_m!.filter((v) => v !== null).length).toBeGreaterThan(g.centre.lat.length * 0.9);
      expect(g.survey!.kerbs.length).toBeGreaterThan(5);
    });

    it("has null elevation, survey and coverage without captures, and fails for unknown tracks", async () => {
      const { api } = await setup();
      const g = await api.trackGeometry(TRACK);
      expect(g.elevation_m).toBeNull();
      expect(g.survey).toBeNull();
      expect(g.coverage).toBeNull();
      expect((await rejection(api.trackGeometry("nope"))).code).toBe("unknown_track");
      expect((await rejection(api.trackGeometry("monza-grand-prix"))).code).toBe("unknown_track"); // synthetic
    });

    it("returns an independent copy each time", async () => {
      const { api } = await setup();
      const a = await api.trackGeometry(TRACK);
      a.centre.lat[0] = 999;
      expect((await api.trackGeometry(TRACK)).centre.lat[0]).not.toBe(999);
    });
  });

  it("compare without ref uses the reference for that track and car", async () => {
    const { api, lap } = await setup();
    expect((await api.compare(lap(1).lap_id)).ref_lap_id).toBe(lap(4).lap_id);
  });

  it("compare across layouts rejects with track_mismatch; another car sets warning", async () => {
    const { api, sessions, lap } = await setup();
    const monza = sessions.find((s) => s.track_id.startsWith("monza"))!;
    const monzaLaps = await api.sessionLaps(monza.session_id);
    const err = await rejection(api.compare(lap(4).lap_id, monzaLaps[1].lap_id));
    expect(err).toBeInstanceOf(ApiError);
    expect(err.code).toBe("track_mismatch");

    const porsche = sessions.find((s) => s.car_name.includes("Porsche"))!;
    const pFlying = (await api.sessionLaps(porsche.session_id)).find((l) => l.kind === "flying")!;
    const cmp = await api.compare(pFlying.lap_id, lap(4).lap_id);
    expect(cmp.warning).toBeTruthy();
    expect(cmp.lap_steering_range_deg).toBeNull();
    expect(cmp.ref_steering_range_deg).toBe(524);
    expect(cmp.lap_car_dims).toBeNull();
    expect(cmp.ref_car_dims).toEqual({ length_m: 4.664, width_m: 2.04, wheelbase_m: 2.696, visual_offset: { forward_m: 0.0745, up_m: -0.3335 } });
  });

  it("compareCandidates excludes Monza laps and the lap itself", async () => {
    const { api, sessions, lap } = await setup();
    const monza = sessions.find((s) => s.track_id.startsWith("monza"))!;
    const monzaIds = new Set((await api.sessionLaps(monza.session_id)).map((l) => l.lap_id));
    const cands = await api.compareCandidates(lap(1).lap_id);
    expect(cands.length).toBeGreaterThan(14);
    expect(cands.every((c) => !monzaIds.has(c.lap_id))).toBe(true);
    expect(cands.some((c) => c.lap_id === lap(1).lap_id)).toBe(false);
    expect(cands.find((c) => c.lap_id === lap(0).lap_id)!.is_previous).toBe(true);
    expect(cands.find((c) => c.lap_id === lap(4).lap_id)!.is_reference).toBe(true);
    expect(cands.some((c) => c.other_car)).toBe(true);
  });
});

describe("track map and landmarks", () => {
  it("has the 15 Spa corners: start from the braking/lift lead-in (or 200 m for flat ones), end from the 150 m rule", async () => {
    const { api } = await setup();
    const map = await api.trackMap(TRACK);
    expect(map.length_m).toBe(6979);
    expect(map.corners).toHaveLength(15);
    expect(map.corners.every((c) => !c.approx)).toBe(true);
    const by = (id: string) => map.corners.find((c) => c.id === id)!;
    expect(by("lasource")).toMatchObject({ start_m: 97, apex_m: 279, end_m: 429 });
    expect(by("eaurouge")).toMatchObject({ start_m: 707, end_m: 958 });
    expect(by("raidillon")).toMatchObject({ start_m: 958, end_m: 1158, complex: "Raidillon" });
    expect(by("busstop")).toMatchObject({ start_m: 6409, end_m: 6819 });
    for (const c of map.corners) expect(c.start_m).toBeLessThan(c.end_m);
  });

  it("kerbRuns, brakeOnset and deriveLandmarks on a small synthetic lap", () => {
    const kerb = new Array<number>(400).fill(0);
    for (const [a, b] of [[50, 60], [120, 125], [190, 210], [230, 235], [350, 360]]) for (let i = a; i <= b; i++) kerb[i] = 1;
    expect(kerbRuns(kerb)).toEqual([{ start: 50, end: 60 }, { start: 120, end: 125 }, { start: 190, end: 210 }, { start: 230, end: 235 }, { start: 350, end: 360 }]);
    const brake = new Array<number>(400).fill(0);
    brake[130] = 0.09; // below the threshold
    for (let i = 150; i <= 190; i++) brake[i] = 0.8;
    expect(brakeOnset(brake, 100, 200)).toBe(150);
    expect(brakeOnset(brake, 100, 140)).toBeNull();

    const corners: Corner[] = [
      { id: "a", name: "A", start_m: 100, apex_m: 200, end_m: 300, complex: null, approx: false },
      { id: "b", name: "B", start_m: 300, apex_m: 380, end_m: 399, complex: null, approx: false },
    ];
    const lms = deriveLandmarks(corners, { brake, kerb }, new Set(["a-board100"]));
    const a = lms.filter((l) => l.corner_id === "a");
    expect(a.filter((l) => l.kind.startsWith("kerb")).map((l) => [l.kind, l.distance_m, l.label, l.confidence])).toEqual([
      ["kerb_entry", 120, "entry kerb", "detected"],
      ["kerb_apex", 190, "apex kerb", "detected"],
      ["kerb_exit", 230, "exit kerb", "detected"],
    ]);
    expect(a.filter((l) => l.kind === "brake_board").map((l) => [l.label, l.distance_m, l.confidence])).toEqual([
      ["150 board", 100, "low"], ["100 board", 150, "confirmed"], ["50 board", 200, "low"],
    ]);
    // Corner b: the kerb at 350 is its entry kerb (apex 380); no braking in its window, so no boards.
    expect(lms.filter((l) => l.corner_id === "b").map((l) => [l.kind, l.distance_m])).toEqual([["kerb_entry", 350]]);
    expect(new Set(lms.map((l) => l.id)).size).toBe(lms.length);
  });

  it("derives landmarks from lap 4 into the map, with Bus Stop and La Source 100 boards confirmed", async () => {
    const { api } = await setup();
    const map = await api.trackMap(TRACK);
    const expected = deriveLandmarks(spaCorners(recLap(4)), recLap(4));
    expect(map.landmarks).toEqual(expected);
    const confirmed = map.landmarks.filter((l) => l.confidence === "confirmed").map((l) => l.id).sort();
    expect(confirmed).toEqual(["busstop-board100", "lasource-board100"]);
    expect(map.landmarks.every((l) => l.confidence !== "low" || l.kind === "brake_board")).toBe(true);
    expect(map.landmarks.filter((l) => l.kind === "kerb_apex" || l.kind === "kerb_entry" || l.kind === "kerb_exit").length).toBeGreaterThan(5);
  });

  it("steering corrections are extra extrema of the smoothed signal over the reference's own", () => {
    // A clean S-curve (one right peak, one left peak) against the same S-curve plus a wobble near the first peak.
    const s = (i: number) => Math.sin((i / 199) * 2 * Math.PI) * 0.5;
    const clean = Array.from({ length: 200 }, (_, i) => s(i));
    const wobbly = clean.map((v, i) => v + 0.2 * Math.sin(i / 4.5) * (i > 15 && i < 55 ? 1 : 0));
    expect(steeringExtrema(clean, 0, 199)).toBe(2);
    expect(steeringCorrections(clean, clean, 0, 199)).toBe(0);
    expect(steeringCorrections(wobbly, clean, 0, 199)).toBeGreaterThanOrEqual(2);
    // the reference's own left-right never counts against the lap
    expect(steeringCorrections(clean, wobbly, 0, 199)).toBe(0);
  });

  it("lap 4 Bus Stop brake onset comes from the lead-in rule, not the window edge", async () => {
    const { api } = await setup();
    const bus = (await api.trackMap(TRACK)).corners.find((c) => c.id === "busstop")!;
    expect(bus.start_m).toBeLessThan(6460);
    const onset = brakeOnset(recLap(4).brake, bus.start_m, bus.apex_m)!;
    expect(onset).toBeGreaterThanOrEqual(6455);
    expect(onset).toBeLessThanOrEqual(6465);
  });
});

describe("coach", () => {
  it("analyze L1 vs L4: exactly 3 issues whose time_s equals the corner delta; no metre cues", async () => {
    const { api, lap } = await setup();
    const L1 = lap(1).lap_id;
    const L4 = lap(4).lap_id;
    const res = await api.coach({ command: "analyze", lap_id: L1, ref_lap_id: null, corner_id: null });
    expect(res.ref_lap_id).toBe(L4);
    const issues = res.findings.filter((f) => f.kind === "issue");
    expect(issues).toHaveLength(3);
    expect(res.findings.filter((f) => f.kind === "minor").length).toBeLessThanOrEqual(1);
    expect(res.findings.filter((f) => f.kind === "strength").length).toBeLessThanOrEqual(1);

    const [cmp, map] = await Promise.all([api.compare(L1, L4), api.trackMap(TRACK)]);
    const complexes = new Set<string>();
    for (const f of res.findings) {
      const c = map.corners.find((x) => x.id === f.corner_id)!;
      expect(c).toBeDefined();
      const delta = cmp.delta[Math.round(c.end_m)] - cmp.delta[Math.round(c.start_m)];
      expect(f.time_s).toBe(round3(delta));
      if (f.kind === "issue") expect(delta).toBeGreaterThanOrEqual(0.05);
      if (f.kind === "strength") expect(delta).toBeLessThanOrEqual(-0.01);
      expect(f.id).toBeTruthy();
      expect(f.reviewed).toBe(false);
      expect(f.fix).not.toMatch(METRE_CUE);
      expect(f.what).not.toMatch(METRE_CUE);
      for (const e of f.evidence) expect(e).not.toMatch(METRE_CUE);
      expect(f.evidence.length).toBeGreaterThanOrEqual(1);
      expect(f.evidence.length).toBeLessThanOrEqual(3);
      expect(f.evidence.some((e) => /^min speed \d+/.test(e))).toBe(true);
      const key = c.complex ?? c.id;
      expect(complexes.has(key)).toBe(false);
      complexes.add(key);
    }
    expect(res.focus).not.toBeNull();
    expect(res.focus!.corner_id).toBe(issues[0].corner_id);
  });

  it("coach text quotes the real minimum speeds of both laps", async () => {
    const { api, lap } = await setup();
    const res = await api.coach({ command: "corner", lap_id: lap(1).lap_id, ref_lap_id: null, corner_id: "pouhon1" });
    const c = spaCorners(recLap(4)).find((x) => x.id === "pouhon1")!;
    const min = (no: number) => Math.min(...recLap(no).speed_kmh.slice(c.start_m, c.end_m + 1));
    const line = res.findings[0].evidence.find((e) => e.startsWith("min speed"))!;
    expect(line).toContain(`${min(1).toFixed(0)}`);
    expect(line).toContain(`${min(4).toFixed(0)} km/h`);
  });

  it("coach resolves only after the 1.2 s delay", async () => {
    vi.useFakeTimers();
    try {
      const api = createMockApi({ loadSpa });
      const sessions = await api.sessions();
      const laps = await api.sessionLaps(sessions.find((s) => s.started_at.startsWith("2026-11-03"))!.session_id);
      let done = false;
      const p = api
        .coach({ command: "analyze", lap_id: laps.find((l) => l.lap_no === 1)!.lap_id, ref_lap_id: null, corner_id: null })
        .then((r) => {
          done = true;
          return r;
        });
      await vi.advanceTimersByTimeAsync(1100);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(150);
      expect(done).toBe(true);
      expect((await p).findings.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("analyze with no reference throws no_reference", async () => {
    const { api, sessions } = await setup();
    const monza = sessions.find((s) => s.track_id.startsWith("monza"))!;
    const lapId = (await api.sessionLaps(monza.session_id)).find((l) => l.kind === "flying")!.lap_id;
    const err = await rejection(api.coach({ command: "analyze", lap_id: lapId, ref_lap_id: null, corner_id: null }));
    expect(err.code).toBe("no_reference");
  });

  it("average: top 3 real per-corner time spreads over the valid flying laps", async () => {
    const { api, lap } = await setup();
    const res = await api.coach({ command: "average", lap_id: lap(4).lap_id, ref_lap_id: null, corner_id: null });
    expect(res.findings).toHaveLength(3);
    expect(res.findings.every((f) => f.kind === "inconsistent" && f.time_s > 0)).toBe(true);
    const expected = spaCorners(recLap(4))
      .map((c) => ({ id: c.id, sd: spread([1, 2, 3, 4].map((no) => recLap(no).t[c.end_m] - recLap(no).t[c.start_m])).sd }))
      .sort((a, b) => b.sd - a.sd)
      .slice(0, 3);
    expect(res.findings.map((f) => f.corner_id)).toEqual(expected.map((e) => e.id));
    expect(res.findings.map((f) => f.time_s)).toEqual(expected.map((e) => round3(e.sd)));
    for (const f of res.findings) expect(f.fix).not.toMatch(METRE_CUE);
    expect(res.stats["Theoretical best"]).toMatch(/^2:2/);
  });

  it("corner returns exactly one finding; unknown corner is rejected", async () => {
    const { api, lap } = await setup();
    const req = { command: "corner" as const, lap_id: lap(1).lap_id, ref_lap_id: null };
    const res = await api.coach({ ...req, corner_id: "pouhon1" });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].corner_id).toBe("pouhon1");
    expect(res.findings[0].fix).not.toMatch(METRE_CUE);
    const err = await rejection(api.coach({ ...req, corner_id: "nope" }));
    expect(err.code).toBe("unknown_corner");
  });

  it("setFindingReviewed persists for later coachResults calls", async () => {
    const { api, lap } = await setup();
    const L1 = lap(1).lap_id;
    const L4 = lap(4).lap_id;
    expect(await api.coachResults(L1, L4)).toEqual({});
    const res = await api.coach({ command: "analyze", lap_id: L1, ref_lap_id: L4, corner_id: null });
    const fid = res.findings[0].id;
    const f = await api.setFindingReviewed(fid, true);
    expect(f.reviewed).toBe(true);
    const again = (await api.coachResults(L1, L4)).analyze as CoachResult;
    expect(again.id).toBe(res.id);
    expect(again.findings.find((x) => x.id === fid)!.reviewed).toBe(true);
    expect(again.findings.filter((x) => x.reviewed)).toHaveLength(1);
    await api.setFindingReviewed(fid, false);
    expect((await api.coachResults(L1, L4)).analyze!.findings.every((x) => !x.reviewed)).toBe(true);
  });

  it("re-analyze keeps reviewed for findings on the same corner and kind", async () => {
    const { api, lap } = await setup();
    const L1 = lap(1).lap_id;
    const L4 = lap(4).lap_id;
    const first = await api.coach({ command: "analyze", lap_id: L1, ref_lap_id: L4, corner_id: null });
    const marked = first.findings[0];
    await api.setFindingReviewed(marked.id, true);
    const second = await api.coach({ command: "analyze", lap_id: L1, ref_lap_id: L4, corner_id: null });
    expect(second.id).not.toBe(first.id);
    const same = second.findings.find((f) => f.corner_id === marked.corner_id && f.kind === marked.kind)!;
    expect(same.reviewed).toBe(true);
    expect(second.findings.filter((f) => f.reviewed)).toHaveLength(1);
    const stored = (await api.coachResults(L1, L4)).analyze!;
    expect(stored.findings.find((f) => f.id === same.id)!.reviewed).toBe(true);
  });
});

describe("laps, pinning and sessions", () => {
  it("patchLap pin changes is_reference; validity override changes the reference", async () => {
    const { api, spaNov3, lap } = await setup();
    const isRef = async (n: number) =>
      (await api.sessionLaps(spaNov3.session_id)).find((l: LapWithRef) => l.lap_no === n)!.is_reference;
    expect(await isRef(4)).toBe(true);
    expect(await isRef(1)).toBe(false);
    const patched = await api.patchLap(lap(1).lap_id, { pinned_reference: true });
    expect(patched.pinned_reference).toBe(true);
    expect(await isRef(1)).toBe(true);
    expect(await isRef(4)).toBe(false);
    await api.patchLap(lap(1).lap_id, { pinned_reference: false });
    expect(await isRef(4)).toBe(true);
    await api.patchLap(lap(4).lap_id, { valid_override: false });
    expect(await isRef(4)).toBe(false);
    // the next best valid flying lap is lap 1 (141.937)
    expect(await isRef(1)).toBe(true);
    expect((await api.compare(lap(3).lap_id)).ref_lap_id).toBe(lap(1).lap_id);
  });

  it("lapTrace honours the channel list", async () => {
    const { api, lap } = await setup();
    const tr = await api.lapTrace(lap(4).lap_id, ["speed_kmh", "t"]);
    expect(Object.keys(tr.ch).sort()).toEqual(["speed_kmh", "t"]);
    expect(tr.distance).toHaveLength(6980);
  });

  it("landmark edits, calibrate, summary, usage and import", async () => {
    const { api, spaNov3, lap } = await setup();
    const tid = spaNov3.track_id;
    const added = await api.addLandmark(tid, {
      id: "x1", label: "my marker", kind: "custom", distance_m: 100, corner_id: "lasource", confidence: "low",
    });
    expect(added.landmarks.find((l) => l.id === "x1")!.confidence).toBe("confirmed");
    const confirmed = await api.patchLandmark(tid, "busstop-board50", { confirm: true });
    expect(confirmed.landmarks.find((l) => l.id === "busstop-board50")!.confidence).toBe("confirmed");
    const moved = await api.patchLandmark(tid, "busstop-board50", { distance_m: 6555 });
    expect(moved.landmarks.find((l) => l.id === "busstop-board50")!.distance_m).toBe(6555);
    const removed = await api.deleteLandmark(tid, "x1");
    expect(removed.landmarks.some((l) => l.id === "x1")).toBe(false);
    expect((await rejection(api.trackMap("nowhere"))).code).toBe("unknown_track");

    const cal = await api.calibrate(tid);
    expect(cal.map.track_id).toBe(tid);
    expect(cal.missing).toEqual([]);

    const sum = await api.sessionSummary(spaNov3.session_id);
    expect(sum.n_laps).toBe(7);
    expect(sum.n_valid).toBe(4);
    expect(sum.best_lap_s).toBe(141.525);
    expect(sum.theoretical_best_s!).toBeLessThan(141.525);
    expect(sum.theoretical_best_s!).toBeGreaterThan(140.5);

    await api.coach({ command: "analyze", lap_id: lap(1).lap_id, ref_lap_id: null, corner_id: null });
    const usage = await api.llmUsage();
    expect(usage.calls).toHaveLength(1);
    expect(usage.total_usd).toBeCloseTo(usage.calls[0].cost_usd ?? 0, 6);

    const imp = await api.importFile("/mnt/d/x/new.duckdb");
    expect(imp.skipped).toBe(false);
    expect((await api.importFile("/mnt/d/x/new.duckdb")).skipped).toBe(true);
  });

  it("sessions list is typed and newest first", async () => {
    const s: SessionMeta[] = await createMockApi({ coachDelayMs: 0, loadSpa }).sessions();
    expect(s.length).toBe(5);
    const times = s.map((x) => x.started_at);
    expect([...times].sort().reverse()).toEqual(times);
  });
});
