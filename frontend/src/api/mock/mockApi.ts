// In-memory implementation of the Api interface, used while VITE_API=mock (and by tests).
// Spa sessions are built from the real 3 Nov recording (fetched lazily on the first call); Monza stays synthetic.
// All state lives inside the object returned by createMockApi(); a page reload resets it.
import type { Api } from "../client";
import {
  ApiError,
  effectiveValid,
  GRID_CHANNELS,
  type CalibrationResult, type ChannelArrays, type CoachRequest, type CoachResult, type CoachResults,
  type Command, type CompareCandidate, type CompareResponse, type Corner, type Finding,
  type CarDims, type FindingKind, type GridChannel, type LlmCall, type SessionMeta, type SessionSummary, type TraceResponse,
  type TrackMap, type LapMeta, type LapWithRef,
} from "../types";
import {
  cornerComparison, narrate, narrateInconsistent, spread, type Cause, type CornerComparison, type Narrative,
} from "./coachFacts";
import { buildElevationIndex, elevationProfile, type ElevationIndex } from "../../lib/elevation";
import { fetchSpaElevation, type ElevationLoader } from "./elevation";
import { fetchSpaRecording, lapToTrace, scaleTime, type SpaLoader, type SpaRecording, type Trace } from "./recording";
import { makeSpaLap, SPA_TRACK_ID } from "./spa";
import { deriveLandmarks, spaCorners, SPA_TRACK_LENGTH_M } from "./spaTrack";

export interface MockOptions {
  /** Delay before coach() resolves (ms). The plan asks for 1.2 s; tests pass 0. */
  coachDelayMs?: number;
  /** Supplies the real Spa recording. Called once, on the first Api call. Default: fetch /mock/spa-2026-11-03.json. */
  loadSpa?: SpaLoader;
  /**
   * Supplies the Spa elevation capture (#94). Default: fetch /mock/spa-elevation-2026-11-05.json, or none when a custom
   * `loadSpa` is given. A failed or null load only means `elevation` is null in compare responses.
   */
  loadElevation?: ElevationLoader;
}

// ---- seed data ----

const MONZA_TRACK_ID = "monza-grand-prix";
const MONZA_LENGTH_M = 5793;
/**
 * Approximate public specs (overall length x width), not measured; real values would come from config/cars.yaml.
 * The Porsche 911 GT3 R (about 4.62 x 2.05 m) is only in the mock as the Spa race session, which is deliberately unknown (null) to exercise the fallback.
 */
const DIMS_720S: CarDims = { length_m: 4.96, width_m: 2.04 };
const CAR_720S = { car_name: "McLaren 720S GT3 Evo", car_id: "mclaren_720s_gt3_evo" };
const CAR_PORSCHE = { car_name: "Porsche 911 GT3 R", car_id: "porsche_911_gt3_r" };

/** `src` is the lap_no in the recording. With `time`, the lap's t is scaled to that time; without, the recording's own time is kept. */
interface SpaLapSpec {
  kind: LapMeta["kind"];
  src: number;
  time?: number;
  valid?: boolean;
}

interface MonzaLapSpec {
  kind: LapMeta["kind"];
  time: number;
  valid?: boolean;
}

interface SessionSpec {
  seed: string;
  started_at: string;
  car: typeof CAR_720S;
  type: string;
  /** Spa only: the recording's range for the 720S, null for the Porsche. */
  steering: "recorded" | null;
  /** null = config/cars.yaml doesn't know the car (exercises the generic GT3 size fallback). */
  dims: CarDims | null;
  trackTempC: number;
  airTempC: number;
  focus: { instruction: string; improved: boolean | null } | null;
  spa?: SpaLapSpec[];
  monza?: MonzaLapSpec[];
}

const SEED: SessionSpec[] = [
  {
    // The real session, laps 0-6 exactly as recorded. Lap 5 is the over-the-limits lap (time 0 = invalid).
    seed: "spa-2026-11-03", started_at: "2026-11-03T19:42:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 31, airTempC: 22,
    focus: { instruction: "Bus Stop: brake at the 100 board", improved: true },
    spa: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 1 },
      { kind: "flying", src: 2 },
      { kind: "flying", src: 3 },
      { kind: "flying", src: 4 },
      { kind: "flying", src: 5, valid: false },
      { kind: "in", src: 6 },
    ],
  },
  {
    seed: "spa-2026-11-01", started_at: "2026-11-01T18:05:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 27, airTempC: 19,
    focus: { instruction: "Pouhon: one steering input through both apexes", improved: true },
    spa: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 3, time: 143.12 },
      { kind: "flying", src: 2, time: 143.909 },
      { kind: "flying", src: 1, time: 144.1 },
      { kind: "in", src: 6 },
    ],
  },
  {
    seed: "spa-2026-10-29-practice", started_at: "2026-10-29T14:30:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 24, airTempC: 17,
    focus: { instruction: "La Source: brake where you did on lap 3", improved: null },
    spa: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 1, time: 143.402 },
      { kind: "flying", src: 3, time: 144.2 },
      { kind: "in", src: 6 },
    ],
  },
  {
    // A different car, and no steering range in the recording or config/cars.yaml (exercises the % fallback).
    seed: "spa-2026-10-29-race", started_at: "2026-10-29T20:10:00", car: CAR_PORSCHE, type: "Race",
    dims: null,
    steering: null, trackTempC: 24, airTempC: 16,
    focus: null,
    spa: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 2, time: 144.35 },
      { kind: "in", src: 6 },
    ],
  },
  {
    // Only an invalid flying lap: no reference, so coach() answers no_reference (Review Focus 2).
    seed: "monza-2026-10-26", started_at: "2026-10-26T16:20:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 29, airTempC: 21,
    focus: null,
    monza: [
      { kind: "out", time: 131.5 },
      { kind: "flying", time: 107.9, valid: false },
      { kind: "in", time: 124.7 },
    ],
  },
];

const DATE_FMT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function fakeSha(seed: string): string {
  // FNV-1a over the whole seed first, then keep mixing to fill 40 hex characters.
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619) >>> 0;
  let out = "";
  while (out.length < 40) {
    h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 3266489917) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    out += h.toString(16).padStart(8, "0");
  }
  return out.slice(0, 40);
}

const pad3 = (n: number) => String(n).padStart(3, "0");
const round3 = (x: number) => Number(x.toFixed(3));
const clone = <T,>(x: T): T => structuredClone(x);

export function formatLapTime(s: number | null): string {
  if (s === null || !Number.isFinite(s)) return "–:––.–––";
  const m = Math.floor(s / 60);
  const r = (s - m * 60).toFixed(3);
  return `${m}:${Number(r) < 10 ? "0" : ""}${r}`;
}

function monzaMap(): TrackMap {
  const c = (id: string, name: string, start: number, apex: number, end: number, complex: string | null = null): Corner =>
    ({ id, name, start_m: start, apex_m: apex, end_m: end, complex, approx: true });
  return {
    track_id: MONZA_TRACK_ID,
    length_m: MONZA_LENGTH_M,
    corners: [
      c("rettifilo1", "Variante del Rettifilo 1", 600, 760, 840, "Rettifilo"),
      c("rettifilo2", "Variante del Rettifilo 2", 840, 900, 1000, "Rettifilo"),
      c("curvagrande", "Curva Grande", 1300, 1700, 1950),
      c("roggia", "Roggia", 2300, 2480, 2600),
      c("lesmo1", "Lesmo 1", 2800, 2920, 3010),
      c("lesmo2", "Lesmo 2", 3200, 3330, 3430),
      c("ascari", "Ascari", 4150, 4330, 4560),
      c("parabolica", "Parabolica", 5150, 5420, 5700),
    ],
    landmarks: [],
  };
}

/** Stretch a Spa trace onto another track length (used for Monza, which has no model of its own). */
function stretch(src: { distance: number[]; ch: ChannelArrays }, length: number): { distance: number[]; ch: ChannelArrays } {
  const n = src.distance.length;
  const ch = {} as ChannelArrays;
  for (const key of GRID_CHANNELS) {
    const a = src.ch[key];
    const out = new Array<number>(length);
    const stepwise = key === "gear" || key === "kerb";
    for (let j = 0; j < length; j++) {
      const pos = (j * (n - 1)) / (length - 1);
      const i0 = Math.floor(pos);
      const i1 = Math.min(i0 + 1, n - 1);
      out[j] = stepwise ? a[i0] : a[i0] + (pos - i0) * (a[i1] - a[i0]);
    }
    ch[key] = out;
  }
  return { distance: Array.from({ length }, (_, j) => j), ch };
}

const COST: Record<Command, { cost: number; input: number; output: number }> = {
  analyze: { cost: 0.0127, input: 2310, output: 690 },
  average: { cost: 0.0089, input: 1850, output: 480 },
  corner: { cost: 0.0061, input: 1220, output: 330 },
};

// ---- factory ----

interface LapRec {
  meta: LapMeta;
  trace: Trace;
  /** Duration of each map segment (corners and the straights between them) on this lap's own clock. */
  segDur: number[];
}

/** Flying, valid and with a real time: can be a reference or count towards best/theoretical. */
const isTimed = (l: LapRec) => l.meta.kind === "flying" && effectiveValid(l.meta) && (l.meta.lap_time_s ?? 0) > 0;
const lapTime = (l: LapRec) => l.meta.lap_time_s ?? 0;

/** Segment boundaries of a map: 0, every corner start and end, ascending. The last segment runs to the end of the lap. */
function segmentBounds(map: TrackMap): number[] {
  return [...new Set([0, ...map.corners.flatMap((c) => [c.start_m, c.end_m])])].sort((a, b) => a - b);
}

function segmentDurations(t: number[], bounds: number[]): number[] {
  const last = t.length - 1;
  return bounds.map((b, k) => t[Math.min(bounds[k + 1] ?? last, last)] - t[Math.min(b, last)]);
}

const cornerTime = (t: number[], c: Corner) => t[Math.min(Math.round(c.end_m), t.length - 1)] - t[Math.min(Math.round(c.start_m), t.length - 1)];

const METRIC: Record<Cause, string> = {
  brake: "brake_point_m", throttle: "throttle_pickup_m", steering: "steering_corrections", speed: "min_speed_kmh",
};

export function createMockApi(opts: MockOptions = {}): Api {
  const coachDelayMs = opts.coachDelayMs ?? 1200;
  const loadSpa = opts.loadSpa ?? fetchSpaRecording;
  const loadElevation: ElevationLoader = opts.loadElevation ?? (opts.loadSpa ? async () => null : fetchSpaElevation);
  let elevationIndex: ElevationIndex | null = null;
  const elevationCache = new Map<Trace, (number | null)[]>();

  const sessions: SessionMeta[] = [];
  const laps = new Map<string, LapRec>();
  const extras = new Map<string, { trackTempC: number; focus: SessionSummary["focus"] }>();
  const dateLabel = new Map<string, string>();
  const maps = new Map<string, TrackMap>();
  const results = new Map<string, Partial<Record<Command, CoachResult>>>();
  const calls: LlmCall[] = [];
  const imported = new Set<string>();
  const compareCache = new Map<string, CompareResponse>();
  let counter = 0;

  /** Builds every session, trace, map and per-lap structure once, after the recording has loaded. */
  function build(rec: SpaRecording) {
    const refLap = rec.laps.find((l) => l.lap_no === 4) ?? rec.laps[0];
    const spaCornerList = spaCorners(refLap);
    const spaMap: TrackMap = {
      track_id: SPA_TRACK_ID, length_m: SPA_TRACK_LENGTH_M, corners: spaCornerList,
      landmarks: deriveLandmarks(spaCornerList, refLap),
    };
    maps.set(SPA_TRACK_ID, spaMap);
    maps.set(MONZA_TRACK_ID, monzaMap());
    const bounds = new Map([...maps].map(([id, m]) => [id, segmentBounds(m)]));
    const baseTraces = new Map<number, Trace>();
    const baseTrace = (no: number) => {
      let tr = baseTraces.get(no);
      if (!tr) {
        const lap = rec.laps.find((l) => l.lap_no === no);
        if (!lap) throw new ApiError("unknown_lap", `The recording has no lap ${no}`);
        tr = lapToTrace(lap);
        baseTraces.set(no, tr);
      }
      return tr;
    };

    for (const sp of SEED) {
      const session_id = fakeSha(sp.seed);
      const spa = !!sp.spa;
      const track_id = spa ? SPA_TRACK_ID : MONZA_TRACK_ID;
      sessions.push({
        session_id,
        track_name: spa ? "Spa-Francorchamps" : "Monza",
        track_layout: "Grand Prix",
        track_id,
        track_length_m: spa ? SPA_TRACK_LENGTH_M : MONZA_LENGTH_M,
        car_name: sp.car.car_name,
        car_id: sp.car.car_id,
        car_class: "GT3",
        session_type: sp.type,
        game_build: "1.2.0.3",
        started_at: sp.started_at,
        driver: "Driver",
        steering_range_deg: sp.steering === "recorded" ? rec.steering_range_deg : null,
        car_dims: sp.dims,
      });
      const d = new Date(sp.started_at);
      dateLabel.set(session_id, `${d.getDate()} ${DATE_FMT[d.getMonth()]}`);
      extras.set(session_id, { trackTempC: sp.trackTempC, focus: sp.focus });

      const specs: { kind: LapMeta["kind"]; valid?: boolean; trace: Trace; lap_time_s: number | null }[] = spa
        ? sp.spa!.map((l) => {
            const recLap = rec.laps.find((x) => x.lap_no === l.src)!;
            const base = baseTrace(l.src);
            return {
              kind: l.kind, valid: l.valid,
              trace: l.time !== undefined ? scaleTime(base, l.time) : base,
              // A recorded 0 means invalid: show the elapsed time instead (the lap stays valid: false).
              lap_time_s: l.time ?? (recLap.lap_time_s === 0 ? recLap.t[recLap.t.length - 1] : recLap.lap_time_s),
            };
          })
        : sp.monza!.map((l) => {
            const synth = makeSpaLap({ lapTimeS: l.time, variant: "ref" });
            return { kind: l.kind, valid: l.valid, trace: stretch(synth, MONZA_LENGTH_M), lap_time_s: l.time };
          });
      specs.forEach((l, lap_no) => {
        const lap_id = `${session_id.slice(0, 12)}-${pad3(lap_no)}`;
        const t = l.trace.ch.t;
        const at = (frac: number) => t[Math.floor(frac * (t.length - 1))];
        const sectors = [round3(at(0.28)), round3(at(0.65) - at(0.28))];
        sectors.push(round3(t[t.length - 1] - sectors[0] - sectors[1]));
        laps.set(lap_id, {
          trace: l.trace,
          segDur: segmentDurations(t, bounds.get(track_id)!),
          meta: {
            lap_id, session_id, lap_no, kind: l.kind, lap_time_s: l.lap_time_s, sectors_s: sectors,
            valid: l.valid ?? true, valid_override: null, pinned_reference: false, source: "own_recording",
            driver: "Driver", track_id, car_id: sp.car.car_id,
            conditions: { track_temp_c: sp.trackTempC, air_temp_c: sp.airTempC, fuel_l: 90 - lap_no * 3, tyre_wear: 0.01 * lap_no },
          },
        });
      });
    }
    sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  // The recording is fetched on the first call of any method, never at import time.
  let ready: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    ready ??= Promise.all([loadSpa(), loadElevation().catch(() => null)]).then(([rec, elev]) => {
      elevationIndex = elev ? buildElevationIndex(elev) : null;
      build(rec);
    }).catch((e) => {
      ready = null;
      throw e instanceof ApiError ? e : new ApiError("network", e instanceof Error ? e.message : "could not load the Spa recording");
    });
    return ready;
  };

  // -- helpers --

  const sessionOf = (id: string): SessionMeta => {
    const s = sessions.find((x) => x.session_id === id);
    if (!s) throw new ApiError("unknown_session", `No session ${id}`);
    return s;
  };
  const lapOf = (id: string): LapRec => {
    const l = laps.get(id);
    if (!l) throw new ApiError("unknown_lap", `No lap ${id}`);
    return l;
  };
  const mapOf = (trackId: string): TrackMap => {
    const m = maps.get(trackId);
    if (!m) throw new ApiError("unknown_track", `No track ${trackId}`);
    return m;
  };
  const sortedSessionLaps = (sid: string) =>
    [...laps.values()].filter((l) => l.meta.session_id === sid).sort((a, b) => a.meta.lap_no - b.meta.lap_no);

  const referenceFor = (trackId: string, carId: string): LapRec | undefined => {
    const same = [...laps.values()].filter((l) => l.meta.track_id === trackId && l.meta.car_id === carId);
    const pinned = same.find((l) => l.meta.pinned_reference);
    if (pinned) return pinned;
    return same.filter(isTimed).sort((a, b) => lapTime(a) - lapTime(b))[0];
  };

  const resolveRef = (lap: LapRec, refId: string | null | undefined): LapRec => {
    const ref = refId ? lapOf(refId) : referenceFor(lap.meta.track_id, lap.meta.car_id);
    if (!ref) throw new ApiError("no_reference", "This lap has no reference: there is no valid flying lap for this track and car.");
    if (ref.meta.track_id !== lap.meta.track_id) {
      throw new ApiError("track_mismatch", "These laps are from different track layouts and cannot be compared.");
    }
    return ref;
  };

  /** Compared on the common grid 0..min(lenA, lenB); laps of equal length share their arrays, longer ones are cut. */
  const compareRecs = (lap: LapRec, ref: LapRec): CompareResponse => {
    const key = `${lap.meta.lap_id}|${ref.meta.lap_id}`;
    const hit = compareCache.get(key);
    if (hit) return hit;
    const a = lap.trace;
    const b = ref.trace;
    const n = Math.min(a.distance.length, b.distance.length);
    const cut = (ch: ChannelArrays): ChannelArrays => {
      if (ch.t.length === n) return ch;
      const out = {} as ChannelArrays;
      for (const k of GRID_CHANNELS) out[k] = ch[k].slice(0, n);
      return out;
    };
    const lapCh = cut(a.ch);
    const refCh = cut(b.ch);
    const elevationOf = (r: LapRec): (number | null)[] | null => {
      if (!elevationIndex || r.meta.track_id !== SPA_TRACK_ID) return null;
      let e = elevationCache.get(r.trace);
      if (!e) {
        e = elevationProfile(elevationIndex, r.trace.ch.lat, r.trace.ch.lon);
        elevationCache.set(r.trace, e);
      }
      return e.length === n ? e : e.slice(0, n);
    };
    const elevLap = elevationOf(lap);
    const elevRef = elevationOf(ref);
    const carName = (r: LapRec) => sessionOf(r.meta.session_id).car_name;
    const res: CompareResponse = {
      lap_id: lap.meta.lap_id,
      ref_lap_id: ref.meta.lap_id,
      lap_kind: lap.meta.kind,
      ref_kind: ref.meta.kind,
      distance: a.distance.length === n ? a.distance : a.distance.slice(0, n),
      lap: lapCh,
      ref: refCh,
      delta: lapCh.t.map((t, i) => t - refCh.t[i]),
      warning:
        lap.meta.car_id !== ref.meta.car_id
          ? `Different car: ${carName(lap)} against ${carName(ref)}. Speeds and braking points are not directly comparable.`
          : null,
      lap_steering_range_deg: sessionOf(lap.meta.session_id).steering_range_deg,
      ref_steering_range_deg: sessionOf(ref.meta.session_id).steering_range_deg,
      elevation: elevLap && elevRef ? { lap: elevLap, ref: elevRef } : null,
      lap_car_dims: sessionOf(lap.meta.session_id).car_dims,
      ref_car_dims: sessionOf(ref.meta.session_id).car_dims,
    };
    compareCache.set(key, res);
    return res;
  };

  const label = (r: LapRec) => {
    const tag = r.meta.kind === "flying" ? "" : ` (${r.meta.kind})`;
    const time = r.meta.lap_time_s === null ? "—" : formatLapTime(r.meta.lap_time_s);
    return `${dateLabel.get(r.meta.session_id)} · L${r.meta.lap_no} ${time}${tag}`;
  };

  const withRef = (r: LapRec): LapWithRef => ({
    ...clone(r.meta),
    is_reference: referenceFor(r.meta.track_id, r.meta.car_id)?.meta.lap_id === r.meta.lap_id,
  });

  /** Best valid lap minus what the best segments of all valid laps would gain (never above the best lap). */
  const theoreticalBest = (sessionId: string): number | null => {
    const valid = sortedSessionLaps(sessionId).filter(isTimed);
    if (!valid.length) return null;
    const best = valid.reduce((a, b) => (lapTime(b) < lapTime(a) ? b : a));
    const gain = best.segDur.reduce((s, d, k) => s + d - Math.min(...valid.map((l) => l.segDur[k])), 0);
    return round3(lapTime(best) - gain);
  };

  const delay = (ms: number) => (ms > 0 ? new Promise<void>((res) => setTimeout(res, ms)) : Promise.resolve());

  // -- coach --

  const comparisons = (map: TrackMap, cmp: CompareResponse): CornerComparison[] =>
    map.corners.map((c) => cornerComparison(c, cmp.lap, cmp.ref, cmp.delta, map.landmarks));

  const makeFinding = (resultId: string, idx: number, c: CornerComparison, kind: "issue" | "minor" | "strength"): { finding: Finding; cause: Cause } => {
    const n = narrate(c, kind);
    return { finding: findingOf(resultId, idx, c.corner, kind, round3(c.delta), n), cause: n.cause };
  };

  const findingOf = (resultId: string, idx: number, corner: Corner, kind: FindingKind, timeS: number, n: Narrative): Finding => ({
    id: `${resultId}-f${idx + 1}`, corner_id: corner.id, corner: corner.name, kind, time_s: timeS,
    what: n.what, fix: n.fix, cue_type: n.cue, evidence: n.evidence, reviewed: false,
  });

  const save = (lap: LapRec, ref: LapRec | undefined, result: CoachResult) => {
    const key = `${lap.meta.lap_id}|${ref?.meta.lap_id ?? ""}`;
    const entry = results.get(key) ?? {};
    // Re-analyze keeps review marks: carry `reviewed` over from the previous result of the same command
    // to findings on the same corner and of the same kind.
    const prev = entry[result.command];
    if (prev) {
      for (const f of result.findings) {
        if (prev.findings.some((p) => p.reviewed && p.corner_id === f.corner_id && p.kind === f.kind)) f.reviewed = true;
      }
    }
    entry[result.command] = result;
    results.set(key, entry);
    const c = COST[result.command];
    calls.push({
      command: result.command, provider: "anthropic", model: "claude-sonnet-5-5",
      input_tokens: c.input, output_tokens: c.output, cost_usd: c.cost, ok: true, created_at: result.created_at,
    });
  };

  const signed = (x: number) => `${x >= 0 ? "+" : "-"}${Math.abs(x).toFixed(3)} s`;

  async function coach(req: CoachRequest): Promise<CoachResult> {
    const lap = lapOf(req.lap_id);
    const session = sessionOf(lap.meta.session_id);
    const map = mapOf(lap.meta.track_id);
    const id = `cr-${++counter}`;
    const base = { id, command: req.command, lap_id: lap.meta.lap_id, warnings: [] as string[], created_at: "" };

    if (req.command === "average") {
      const valid = sortedSessionLaps(session.session_id).filter(isTimed);
      if (valid.length < 2) throw new ApiError("not_enough_laps", "Average needs at least 2 valid flying laps in the session.");
      const ref = req.ref_lap_id ? lapOf(req.ref_lap_id) : referenceFor(lap.meta.track_id, lap.meta.car_id);
      await delay(coachDelayMs);
      const times = valid.map(lapTime);
      const lapSpread = spread(times);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;
      const spreads = map.corners
        .map((c) => ({ c, st: spread(valid.map((l) => cornerTime(l.trace.ch.t, c))) }))
        .sort((a, b) => b.st.sd - a.st.sd)
        .slice(0, 3);
      const findings = spreads.map(({ c, st }, i) =>
        findingOf(id, i, c, "inconsistent", round3(st.sd), narrateInconsistent(c, st, map.landmarks.filter((l) => l.corner_id === c.id && l.confidence !== "low"))),
      );
      const result: CoachResult = {
        ...base, created_at: new Date().toISOString(), ref_lap_id: ref?.meta.lap_id ?? null,
        summary: `Lap times vary by ${lapSpread.sd.toFixed(3)} s across ${valid.length} valid laps. ${spreads.map((x) => x.c.name).join(", ")} are where the time moves.`,
        findings, focus: null, encouragement: null,
        stats: {
          Laps: String(valid.length), Mean: formatLapTime(mean), "Lap sd": `${lapSpread.sd.toFixed(3)} s`, Best: formatLapTime(lapSpread.min),
          "Theoretical best": formatLapTime(theoreticalBest(session.session_id)),
        },
        cost_usd: COST.average.cost,
      };
      save(lap, ref, result);
      return clone(result);
    }

    const ref = resolveRef(lap, req.ref_lap_id);
    const cmp = compareRecs(lap, ref);
    const facts = comparisons(map, cmp);
    const total = cmp.delta[cmp.delta.length - 1];
    const stats = { Lap: label(lap), Reference: label(ref), "Δ lap": signed(total) };

    if (req.command === "corner") {
      const f = facts.find((x) => x.corner.id === req.corner_id);
      if (!f) throw new ApiError("unknown_corner", `No corner ${req.corner_id} on this track.`);
      await delay(coachDelayMs);
      const kind = f.delta >= 0.05 ? "issue" : f.delta <= -0.01 ? "strength" : "minor";
      const { finding } = makeFinding(id, 0, f, kind);
      const result: CoachResult = {
        ...base, created_at: new Date().toISOString(), ref_lap_id: ref.meta.lap_id,
        summary: `${f.corner.name}: ${signed(f.delta)} against the reference.`,
        findings: [finding], focus: null, encouragement: null, stats, cost_usd: COST.corner.cost,
      };
      save(lap, ref, result);
      return clone(result);
    }

    // analyze: top 5 losing corners (one per complex) plus the best gaining one, then the kind rules.
    await delay(coachDelayMs);
    const seen = new Set<string>();
    const ordered = [...facts].sort((a, b) => b.delta - a.delta).filter((f) => {
      const key = f.corner.complex ?? f.corner.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const losing = ordered.slice(0, 5);
    const gain = ordered[ordered.length - 1];
    const issues = losing.filter((f) => f.delta >= 0.05).slice(0, 3);
    const minor = losing.filter((f) => !issues.includes(f) && f.delta >= 0.01)[0];
    const strength = gain && gain.delta <= -0.01 ? gain : undefined;
    const built: { finding: Finding; cause: Cause }[] = [];
    const add = (f: CornerComparison, kind: "issue" | "minor" | "strength") => built.push(makeFinding(id, built.length, f, kind));
    issues.forEach((f) => add(f, "issue"));
    if (minor) add(minor, "minor");
    if (strength) add(strength, "strength");
    const findings = built.map((b) => b.finding);

    const top = issues[0];
    const result: CoachResult = {
      ...base, created_at: new Date().toISOString(), ref_lap_id: ref.meta.lap_id,
      summary:
        lap.meta.lap_id === ref.meta.lap_id
          ? "This lap is the comparison lap, so there is nothing to compare."
          : `${signed(total)} against the reference.${issues.length ? ` It goes at ${issues.map((f) => f.corner.name).join(", ")}.` : ""}`,
      findings,
      focus: top ? { corner_id: top.corner.id, instruction: findings[0].fix, metric: METRIC[built[0].cause] } : null,
      encouragement: strength ? `${strength.corner.name} is quicker than your reference. Keep that commitment.` : null,
      stats, cost_usd: COST.analyze.cost,
    };
    save(lap, ref, result);
    if (top) extras.get(session.session_id)!.focus = { instruction: result.focus!.instruction, improved: null };
    return clone(result);
  }

  const api: Api = {
    async sessions() {
      return clone(sessions);
    },
    async sessionLaps(sessionId) {
      sessionOf(sessionId);
      return sortedSessionLaps(sessionId).map(withRef);
    },
    async patchLap(lapId, patch) {
      const lap = lapOf(lapId);
      if (patch.valid_override !== undefined) lap.meta.valid_override = patch.valid_override;
      if (patch.pinned_reference !== undefined) {
        if (patch.pinned_reference) {
          for (const o of laps.values()) {
            if (o.meta.track_id === lap.meta.track_id && o.meta.car_id === lap.meta.car_id) o.meta.pinned_reference = false;
          }
        }
        lap.meta.pinned_reference = patch.pinned_reference;
      }
      return clone(lap.meta);
    },
    async lapTrace(lapId, channels): Promise<TraceResponse> {
      const tr = lapOf(lapId).trace;
      const keys: readonly GridChannel[] = channels?.length ? channels : GRID_CHANNELS;
      const ch: TraceResponse["ch"] = {};
      for (const k of keys) ch[k] = tr.ch[k];
      return { distance: tr.distance, ch };
    },
    async compare(lap, ref) {
      const l = lapOf(lap);
      return compareRecs(l, resolveRef(l, ref));
    },
    async compareCandidates(lapId): Promise<CompareCandidate[]> {
      const lap = lapOf(lapId);
      const ref = referenceFor(lap.meta.track_id, lap.meta.car_id);
      const startedAt = (r: LapRec) => sessionOf(r.meta.session_id).started_at;
      return [...laps.values()]
        .filter((r) => r.meta.track_id === lap.meta.track_id && r.meta.lap_id !== lapId)
        .sort((a, b) => startedAt(b).localeCompare(startedAt(a)) || b.meta.lap_no - a.meta.lap_no)
        .map((r) => ({
          lap_id: r.meta.lap_id,
          label: label(r),
          lap_time_s: r.meta.lap_time_s,
          car_name: sessionOf(r.meta.session_id).car_name,
          is_reference: ref?.meta.lap_id === r.meta.lap_id,
          is_previous: r.meta.session_id === lap.meta.session_id && r.meta.lap_no === lap.meta.lap_no - 1,
          other_car: r.meta.car_id !== lap.meta.car_id,
        }));
    },
    async trackMap(trackId) {
      return clone(mapOf(trackId));
    },
    async addLandmark(trackId, landmark) {
      const m = mapOf(trackId);
      const id = m.landmarks.some((l) => l.id === landmark.id) ? `lm-${++counter}` : landmark.id;
      m.landmarks.push({ ...clone(landmark), id, confidence: "confirmed" });
      return clone(m);
    },
    async patchLandmark(trackId, landmarkId, patch) {
      const m = mapOf(trackId);
      const lm = m.landmarks.find((l) => l.id === landmarkId);
      if (!lm) throw new ApiError("unknown_landmark", `No landmark ${landmarkId}`);
      if (patch.distance_m !== undefined) lm.distance_m = patch.distance_m;
      // Assumption: moving a landmark by hand also confirms it.
      if (patch.confirm || patch.distance_m !== undefined) lm.confidence = "confirmed";
      return clone(m);
    },
    async deleteLandmark(trackId, landmarkId) {
      const m = mapOf(trackId);
      if (!m.landmarks.some((l) => l.id === landmarkId)) throw new ApiError("unknown_landmark", `No landmark ${landmarkId}`);
      m.landmarks = m.landmarks.filter((l) => l.id !== landmarkId);
      return clone(m);
    },
    coach,
    async coachResults(lap, ref): Promise<CoachResults> {
      return clone(results.get(`${lap}|${ref}`) ?? {});
    },
    async setFindingReviewed(findingId, reviewed) {
      for (const entry of results.values()) {
        for (const res of Object.values(entry)) {
          const f = res.findings.find((x) => x.id === findingId);
          if (f) {
            f.reviewed = reviewed;
            return clone(f);
          }
        }
      }
      throw new ApiError("unknown_finding", `No finding ${findingId}`);
    },
    async sessionSummary(sessionId): Promise<SessionSummary> {
      sessionOf(sessionId);
      const recs = sortedSessionLaps(sessionId);
      const valid = recs.filter(isTimed);
      const x = extras.get(sessionId)!;
      return {
        n_laps: recs.length,
        n_valid: valid.length,
        best_lap_s: valid.length ? Math.min(...valid.map(lapTime)) : null,
        theoretical_best_s: theoreticalBest(sessionId),
        track_temp_c: x.trackTempC,
        focus: clone(x.focus),
      };
    },
    async calibrate(trackId): Promise<CalibrationResult> {
      const m = mapOf(trackId);
      const onTrack = [...laps.values()].filter((l) => l.meta.track_id === trackId);
      const ref = onTrack.find((l) => l.meta.pinned_reference) ?? onTrack.filter(isTimed).sort((a, b) => lapTime(a) - lapTime(b))[0];
      if (!ref) throw new ApiError("no_reference", "Calibration needs a reference lap, and this track has none.");
      return {
        map: clone(m),
        // The Kemmel kink is detected as a flat zone that is not in the mapped corner list.
        unmapped: trackId === SPA_TRACK_ID ? [{ apex_m: 1700, start_m: 1560, end_m: 1830, min_speed_kmh: 262, flat: true }] : [],
        missing: [],
      };
    },
    async importFile(path) {
      const skipped = imported.has(path);
      imported.add(path);
      // The mock does not add sessions; it only mimics the result and the idempotence.
      return { session_id: fakeSha(path), n_laps: skipped ? 0 : 7, skipped };
    },
    async llmUsage() {
      return { calls: clone(calls), total_usd: calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0) };
    },
  };

  // Every method waits for the one-time load first.
  const lazy = {} as Api;
  for (const k of Object.keys(api) as (keyof Api)[]) {
    (lazy as unknown as Record<string, unknown>)[k] = async (...args: unknown[]) => {
      await ensure();
      return (api[k] as (...a: unknown[]) => Promise<unknown>)(...args);
    };
  }
  return lazy;
}
