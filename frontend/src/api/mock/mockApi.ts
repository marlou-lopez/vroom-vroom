// In-memory implementation of the Api interface, used while VITE_API=mock (and by tests).
// Spa and Monza sessions are built from the real 3 Nov (Spa) and 5 Nov (Monza) recordings, fetched lazily on the first call.
// All state lives inside the object returned by createMockApi(); a page reload resets it.
import type { Api } from "../client";
import {
  ApiError,
  effectiveValid,
  GRID_CHANNELS,
  IDEAL_REF_PREFIX,
  idealRefId,
  idealRefSession,
  type CalibrationResult, type ChannelArrays, type CoachRequest, type CoachResult, type CoachResults,
  type Command, type CompareCandidate, type CompareResponse, type Corner, type Finding,
  type CarDims, type CarSetup, type FindingKind, type GridChannel, type IdealLap, type IdealScope, type IdealSegment, type LlmCall, type SegmentTimes, type SessionMeta, type SessionReport, type SessionSummary, type Stint, type StintLap, type TraceResponse,
  type TrackMap, type LapMeta, type LapWithRef, type TrackGeometry,
} from "../types";
import {
  cornerComparison, narrate, narrateInconsistent, spread, type Cause, type CornerComparison, type Narrative,
} from "./coachFacts";
import { buildElevationIndex, elevationProfile, EARTH_RADIUS_M, type ElevationIndex } from "../../lib/elevation";
import { mapSurvey, type SurveyFile } from "../../lib/trackSurvey";
import { formatLapTime } from "../../lib/format";
import { fetchSpaElevation, type ElevationLoader } from "./elevation";
import { fetchSpaAerial, type AerialLoader } from "./aerial";
import { mapAerial, type AerialFile } from "../../lib/aerialEdges";
import { fetchSpaSurvey, type SurveyLoader } from "./survey";
import { balanceForApi, compareBalance, runsForApi } from "../../lib/carBalance";
import { fetchMonzaStint, fetchSpaRaceStint, splitStints, type StintFile, type StintLoader } from "./stint";
import { fetchRecording, fetchSpaRace, lapToTrace, scaleTime, type Recording, type RecordingLap, type RecordingLoader, type RecordingTrack, type Trace } from "./recording";
import { monzaCorners, MONZA_TRACK_ID, MONZA_TRACK_LENGTH_M } from "./monzaTrack";
import { aidRuns } from "../../lib/driverAids";
import { buildSessionReport, type TraceFacts } from "../../lib/sessionReport";
import { setupLabel } from "./setupLabels";
import { deriveLandmarks, spaCorners, SPA_TRACK_ID, SPA_TRACK_LENGTH_M } from "./spaTrack";

export interface MockOptions {
  /** Delay before coach() resolves (ms). The plan asks for 1.2 s; tests pass 0. */
  coachDelayMs?: number;
  /** Supplies the real Spa recording. Called once, on the first Api call. Default: fetch /mock/spa-2026-11-03.json. */
  loadSpa?: RecordingLoader;
  /**
   * Supplies the real Monza recording, like `loadSpa`. Default: fetch /mock/monza-2026-11-05.json. When a custom loader is
   * given for one track and not the other, the other track has no sessions.
   */
  loadMonza?: RecordingLoader;
  /**
   * Supplies the Spa elevation capture (#94). Default: fetch /mock/spa-elevation-2026-11-05.json, or none when a custom
   * `loadSpa` or `loadMonza` is given. A failed or null load only means `elevation_m` is null in the track geometry.
   */
  loadElevation?: ElevationLoader;
  /**
   * Supplies the Spa track survey (#97). Default: fetch /mock/spa-survey-2026-11-06.json, or none when a custom
   * `loadSpa` or `loadMonza` is given. A failed or null load only means `survey` is null in the track geometry.
   */
  loadSurvey?: SurveyLoader;
  /** Supplies Spa's edges and kerbs from aerial imagery (vroom-ueg.8). Default: fetch /mock/spa-aerial-2023.json, or none like `loadSurvey`. */
  loadAerial?: AerialLoader;
  /**
   * Supplies the Monza race of 9 Nov 2026, a session with lap metadata and stint stats only (no 1 m traces). Default: fetch
   * /mock/monza-stint-2026-11-09.json, or no such session when a custom `loadSpa` or `loadMonza` is given. A failure to load it
   * leaves the session out.
   */
  loadStint?: StintLoader;
  /**
   * Supplies the Spa race of 10 Nov 2026 with a 1 m trace for every lap (vroom-bi4.10). Default: fetch
   * /mock/spa-race-2026-11-10.json, or no such session when a custom `loadSpa` or `loadMonza` is given. It needs `loadSpaRaceStint` too.
   */
  loadSpaRace?: RecordingLoader;
  /** Supplies the stint stats of that race. Default: fetch /mock/spa-race-stint-2026-11-10.json (none when a custom loader is given). */
  loadSpaRaceStint?: StintLoader;
}

// ---- seed data ----

/**
 * McLaren 720S GT3: length 4,664 mm, width 2,040 mm, wheelbase 2,696 mm, from McLaren's customer-racing technical sheet
 * (https://mclaren.pagetiger.com/coeljug/1/page3.htm) and https://www.ultimatecarpage.com/spec/6972/McLaren-720S-GT3.html.
 * These are the original 720S GT3 figures; an Evo-specific sheet was not found, and the mock's car is the Evo.
 * `visual_offset` is LMU's `mPhysicsToGraphicsOffset` for this car, read from the player in four shared-memory captures
 * (constant in all of them): (0, -0.3335, -0.0745) in vehicle axes (+x left, +y up, +z back), i.e. the visual centre is
 * 7.45 cm ahead of and 33.35 cm below the recorded position. See docs/track-views/cockpit-view.md.
 * Real values would come from config/cars.yaml. The Porsche 911 GT3 R is only in the mock as the Spa race session, which is
 * deliberately unknown (null) to exercise the fallback.
 */
const DIMS_720S: CarDims = { length_m: 4.664, width_m: 2.04, wheelbase_m: 2.696, visual_offset: { forward_m: 0.0745, up_m: -0.3335 } };
const CAR_720S = { car_name: "McLaren 720S GT3 Evo", car_id: "mclaren_720s_gt3_evo" };
const CAR_PORSCHE = { car_name: "Porsche 911 GT3 R", car_id: "porsche_911_gt3_r" };

/** `src` is the lap_no in the recording. With `time`, the lap's t is scaled to that time; without, the recording's own time is kept. */
interface LapSpec {
  kind: LapMeta["kind"];
  src: number;
  time?: number;
  valid?: boolean;
}

interface SessionSpec {
  seed: string;
  track: RecordingTrack;
  started_at: string;
  car: typeof CAR_720S;
  type: string;
  /** The recording's steering range for the 720S, null for the Porsche. */
  steering: "recorded" | null;
  /** null = config/cars.yaml doesn't know the car (exercises the generic GT3 size fallback). */
  dims: CarDims | null;
  trackTempC: number;
  airTempC: number;
  focus: { instruction: string; improved: boolean | null } | null;
  /** null = the session has no setup (empty list). Otherwise the recording's real setup, with `setupOverrides` laid over it. */
  setup: "recorded" | null;
  /** SYNTHETIC (vroom-pnw.25): display strings replacing the real recording's, so a session differs from the real one. Not recorded data. */
  setupOverrides?: Record<string, string>;
  laps: LapSpec[];
}

const SEED: SessionSpec[] = [
  {
    // The real session, laps 0-6 exactly as recorded. Lap 5 is the over-the-limits lap (time 0 = invalid).
    seed: "spa-2026-11-03", track: "spa", started_at: "2026-11-03T19:42:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 31, airTempC: 22, setup: "recorded",
    focus: { instruction: "Bus Stop: brake at the 100 board", improved: true },
    laps: [
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
    seed: "spa-2026-11-01", track: "spa", started_at: "2026-11-01T18:05:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 27, airTempC: 19, setup: "recorded",
    // SYNTHETIC: this session's recording is the 3 Nov one, so give it a few different settings to exercise the setup diff.
    setupOverrides: { VM_REAR_WING: "8.0 deg", VM_FRONT_ANTISWAY: "P2 20x2mm", VM_BRAKE_BALANCE: "53.5:46.5" },
    focus: { instruction: "Pouhon: one steering input through both apexes", improved: true },
    laps: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 3, time: 143.12 },
      { kind: "flying", src: 2, time: 143.909 },
      { kind: "flying", src: 1, time: 144.1 },
      { kind: "in", src: 6 },
    ],
  },
  {
    seed: "spa-2026-10-29-practice", track: "spa", started_at: "2026-10-29T14:30:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 24, airTempC: 17, setup: "recorded",
    focus: { instruction: "La Source: brake where you did on lap 3", improved: null },
    laps: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 1, time: 143.402 },
      { kind: "flying", src: 3, time: 144.2 },
      { kind: "in", src: 6 },
    ],
  },
  {
    // A different car, and no steering range in the recording or config/cars.yaml (exercises the % fallback).
    seed: "spa-2026-10-29-race", track: "spa", started_at: "2026-10-29T20:10:00", car: CAR_PORSCHE, type: "Race",
    dims: null,
    steering: null, trackTempC: 24, airTempC: 16, setup: null,
    focus: null,
    laps: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 2, time: 144.35 },
      { kind: "in", src: 6 },
    ],
  },
  {
    // The real Monza session, laps 0 and 5-13 as recorded (laps 1-4 are left out to keep the file small: they have no official
    // time). Laps 7 and 13 end in the pits (in laps), lap 8 starts there (out lap). Their recorded time is 0, so the mock shows
    // the elapsed time.
    seed: "monza-2026-11-05", track: "monza", started_at: "2026-11-05T08:10:00", car: CAR_720S, type: "Practice",
    dims: DIMS_720S,
    steering: "recorded", trackTempC: 33, airTempC: 24, setup: "recorded",
    focus: { instruction: "Ascari: stay tight through the first apex", improved: null },
    laps: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 5 },
      { kind: "flying", src: 6 },
      { kind: "in", src: 7 },
      { kind: "out", src: 8 },
      { kind: "flying", src: 9 },
      { kind: "flying", src: 10 },
      { kind: "flying", src: 11 },
      { kind: "flying", src: 12 },
      { kind: "in", src: 13 },
    ],
  },
  {
    // A different car with only an invalid flying lap: no reference for that car, so coach() answers no_reference (Review Focus 2).
    // The laps are the 720S recording's, as with the Spa race session.
    seed: "monza-2026-10-26", track: "monza", started_at: "2026-10-26T16:20:00", car: CAR_PORSCHE, type: "Practice",
    dims: null,
    steering: null, trackTempC: 29, airTempC: 21, setup: null,
    focus: null,
    laps: [
      { kind: "out", src: 0 },
      { kind: "flying", src: 9, valid: false },
      { kind: "in", src: 13 },
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

const COST: Record<Command, { cost: number; input: number; output: number }> = {
  analyze: { cost: 0.0127, input: 2310, output: 690 },
  average: { cost: 0.0089, input: 1850, output: 480 },
  corner: { cost: 0.0061, input: 1220, output: 330 },
};

// ---- factory ----

interface LapRec {
  meta: LapMeta;
  trace: Trace;
  /** The stitched ideal lap only: grid metres where the source lap changes. */
  joins?: number[];
}

/** Flying, valid and with a real time: can be a reference or count towards best/theoretical. */
const isTimed = (l: LapRec) => l.meta.kind === "flying" && effectiveValid(l.meta) && (l.meta.lap_time_s ?? 0) > 0;
const lapTime = (l: LapRec) => l.meta.lap_time_s ?? 0;

/** A stretch of the track between two boundaries of the map: a corner, or the straight between two corners. */
interface MapSegment {
  label: string;
  corner_id: string | null;
  start_m: number;
  end_m: number;
}

/**
 * The map's segments: boundaries at 0, every corner start and end, and the track length, so they tile the lap. A segment that
 * starts where a corner starts is that corner; the others are straights, named from the corner before and the one after.
 */
function mapSegments(map: TrackMap): MapSegment[] {
  const corners = [...map.corners].sort((a, b) => a.start_m - b.start_m);
  const bounds = [...new Set([0, ...corners.flatMap((c) => [c.start_m, c.end_m]).filter((m) => m > 0 && m < map.length_m), map.length_m])]
    .sort((a, b) => a - b);
  const out: MapSegment[] = [];
  for (let k = 0; k + 1 < bounds.length; k++) {
    const start_m = bounds[k], end_m = bounds[k + 1];
    const corner = corners.find((c) => c.start_m === start_m && c.end_m === end_m);
    if (corner) {
      out.push({ label: corner.name, corner_id: corner.id, start_m, end_m });
      continue;
    }
    const before = [...corners].reverse().find((c) => c.end_m <= start_m);
    const after = corners.find((c) => c.start_m >= end_m);
    out.push({ label: `${before?.name ?? "Start"} → ${after?.name ?? "Finish"}`, corner_id: null, start_m, end_m });
  }
  return out;
}

/** The recorded sectors scaled to a re-timed lap, so the three still add up to its time. */
function fitSectors(rec: number[], lapTimeS: number): number[] {
  const total = rec[0] + rec[1] + rec[2];
  if (Math.abs(total - lapTimeS) < 0.002) return [...rec]; // not re-timed: as recorded
  const f = lapTimeS / total;
  const s1 = round3(rec[0] * f), s2 = round3(rec[1] * f);
  return [s1, s2, round3(lapTimeS - s1 - s2)];
}

/** Duration of each segment on the lap's own clock, scaled so they add up to `lapTimeS` (the official time vs the grid's last sample). */
function segmentDurations(t: number[], segs: MapSegment[], lapTimeS: number): number[] {
  const last = t.length - 1;
  const at = (m: number) => t[Math.min(Math.round(m), last)];
  const scale = lapTimeS > 0 && t[last] > t[0] ? lapTimeS / (t[last] - t[0]) : 1;
  return segs.map((s) => (at(s.end_m) - at(s.start_m)) * scale);
}

const cornerTime = (t: number[], c: Corner) => t[Math.min(Math.round(c.end_m), t.length - 1)] - t[Math.min(Math.round(c.start_m), t.length - 1)];

const METRIC: Record<Cause, string> = {
  brake: "brake_point_m", throttle: "throttle_pickup_m", steering: "steering_corrections", speed: "min_speed_kmh",
};

export function createMockApi(opts: MockOptions = {}): Api {
  const coachDelayMs = opts.coachDelayMs ?? 1200;
  // A custom loader for either track means a test or caller is in charge: the other track and the Spa extras are then off unless given.
  const custom = !!(opts.loadSpa || opts.loadMonza);
  const loaders: Record<RecordingTrack, RecordingLoader | null> = {
    spa: opts.loadSpa ?? (custom ? null : () => fetchRecording("spa")),
    monza: opts.loadMonza ?? (custom ? null : () => fetchRecording("monza")),
  };
  const loadElevation: ElevationLoader = opts.loadElevation ?? (custom ? async () => null : fetchSpaElevation);
  let elevationIndex: ElevationIndex | null = null;
  const loadSurvey: SurveyLoader = opts.loadSurvey ?? (custom ? async () => null : fetchSpaSurvey);
  let surveyFile: SurveyFile | null = null;
  const loadAerial: AerialLoader = opts.loadAerial ?? (custom ? async () => null : fetchSpaAerial);
  let aerialFile: AerialFile | null = null;
  const loadStint: StintLoader = opts.loadStint ?? (custom ? async () => null : fetchMonzaStint);
  const loadSpaRace: RecordingLoader | null = opts.loadSpaRace ?? (custom ? null : fetchSpaRace);
  const loadSpaRaceStint: StintLoader = opts.loadSpaRaceStint ?? (custom ? async () => null : fetchSpaRaceStint);

  const sessions: SessionMeta[] = [];
  const laps = new Map<string, LapRec>();
  /** Sessions known by lap metadata and stint stats only (no traces): their laps, and the stint stats per session. */
  const metaLaps = new Map<string, LapMeta[]>();
  const stintStats = new Map<string, StintLap[]>();
  const setups = new Map<string, CarSetup>();
  /** In-car setting changes per session (only the Spa race has them), for the session report. */
  const settingLog = new Map<string, NonNullable<Parameters<typeof buildSessionReport>[0]["settings"]>>();
  const extras = new Map<string, { trackTempC: number; focus: SessionSummary["focus"] }>();
  const dateLabel = new Map<string, string>();
  const maps = new Map<string, TrackMap>();
  const results = new Map<string, Partial<Record<Command, CoachResult>>>();
  const calls: LlmCall[] = [];
  const imported = new Set<string>();
  const compareCache = new Map<string, CompareResponse>();
  let counter = 0;

  /** Builds every session, trace, map and per-lap structure once, after the recordings have loaded. */
  function build(recs: Partial<Record<RecordingTrack, Recording>>, stintFile: StintFile | null, race: { rec: Recording; stint: StintFile } | null) {
    const trackInfo: Record<RecordingTrack, { id: string; name: string; length: number; map: (ref: RecordingLap) => TrackMap }> = {
      spa: {
        id: SPA_TRACK_ID, name: "Spa-Francorchamps", length: SPA_TRACK_LENGTH_M,
        map: (ref) => {
          const corners = spaCorners(ref);
          return { track_id: SPA_TRACK_ID, length_m: SPA_TRACK_LENGTH_M, corners, landmarks: deriveLandmarks(corners, ref) };
        },
      },
      monza: {
        id: MONZA_TRACK_ID, name: "Monza", length: MONZA_TRACK_LENGTH_M,
        map: (ref) => {
          const corners = monzaCorners(ref);
          return { track_id: MONZA_TRACK_ID, length_m: MONZA_TRACK_LENGTH_M, corners, landmarks: deriveLandmarks(corners, ref) };
        },
      },
    };
    // The reference lap the corner map is read from: Spa lap 4, Monza lap 6 (the fastest valid lap of each recording).
    const REF_LAP: Record<RecordingTrack, number> = { spa: 4, monza: 6 };
    for (const track of Object.keys(recs) as RecordingTrack[]) {
      const rec = recs[track]!;
      maps.set(trackInfo[track].id, trackInfo[track].map(rec.laps.find((l) => l.lap_no === REF_LAP[track]) ?? rec.laps[0]));
    }
    const baseTraces = new Map<string, Trace>();
    const baseTrace = (track: RecordingTrack, no: number) => {
      const key = `${track}:${no}`;
      let tr = baseTraces.get(key);
      if (!tr) {
        const lap = recs[track]!.laps.find((l) => l.lap_no === no);
        if (!lap) throw new ApiError("unknown_lap", `The ${track} recording has no lap ${no}`);
        tr = lapToTrace(lap);
        baseTraces.set(key, tr);
      }
      return tr;
    };

    for (const sp of SEED) {
      const rec = recs[sp.track];
      if (!rec) continue;
      const info = trackInfo[sp.track];
      const session_id = fakeSha(sp.seed);
      const track_id = info.id;
      sessions.push({
        session_id,
        track_name: info.name,
        track_layout: "Grand Prix",
        track_id,
        track_length_m: info.length,
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
      const display = { ...rec.car_setup, ...(sp.setupOverrides ?? {}) };
      setups.set(session_id, {
        entries: sp.setup === "recorded" ? Object.entries(display).map(([key, value]) => ({ key, label: setupLabel(key), value })) : [],
      });

      const specs: { kind: LapMeta["kind"]; valid?: boolean; trace: Trace; lap_time_s: number | null; src_sectors: number[] | null }[] = sp.laps.map((l) => {
        const recLap = rec.laps.find((x) => x.lap_no === l.src)!;
        const base = baseTrace(sp.track, l.src);
        return {
          kind: l.kind, valid: l.valid,
          src_sectors: recLap.sectors_s ?? null,
          trace: l.time !== undefined ? scaleTime(base, l.time) : base,
          // A recorded 0 means invalid: show the elapsed time instead (the lap stays valid: false).
          lap_time_s: l.time ?? (recLap.lap_time_s === 0 ? recLap.t[recLap.t.length - 1] : recLap.lap_time_s),
        };
      });
      specs.forEach((l, lap_no) => {
        const lap_id = `${session_id.slice(0, 12)}-${pad3(lap_no)}`;
        // Real sectors from the recording; none on an invalid, out or in lap. A re-timed lap (`time`) scales them with its clock.
        const recSectors = l.src_sectors ?? [];
        const sectors = recSectors.length === 3 && l.kind === "flying" && l.valid !== false && l.lap_time_s
          ? fitSectors(recSectors, l.lap_time_s)
          : [];
        laps.set(lap_id, {
          trace: l.trace,
          meta: {
            lap_id, session_id, lap_no, kind: l.kind, lap_time_s: l.lap_time_s, sectors_s: sectors,
            valid: l.valid ?? true, valid_override: null, pinned_reference: false, source: "own_recording",
            driver: "Driver", track_id, car_id: sp.car.car_id,
            has_trace: true,
          },
        });
      });
    }
    if (stintFile && recs.monza) addStintSession(stintFile);
    if (race && recs.spa) addSpaRaceSession(race.rec, race.stint);
    sessions.sort((a, b) => b.started_at.localeCompare(a.started_at));
  }

  /**
   * The real Monza race of 9 Nov 2026 (McLaren 720S GT3 Evo): a session with lap metadata and stint stats from the recording
   * and no traces, because its 1 m traces would add about 15 MB. Its laps have `has_trace: false`.
   */
  function addStintSession(file: StintFile) {
    const session_id = fakeSha("monza-2026-11-09-race");
    const started_at = "2026-11-09T11:57:00";
    sessions.push({
      session_id, track_name: "Monza", track_layout: "Grand Prix", track_id: MONZA_TRACK_ID, track_length_m: MONZA_TRACK_LENGTH_M,
      car_name: CAR_720S.car_name, car_id: CAR_720S.car_id, car_class: file.car_class, session_type: file.session_type,
      game_build: "1.2.0.3", started_at, driver: "Driver", steering_range_deg: null, car_dims: DIMS_720S,
    });
    const d = new Date(started_at);
    dateLabel.set(session_id, `${d.getDate()} ${DATE_FMT[d.getMonth()]}`);
    extras.set(session_id, { trackTempC: file.laps[0]?.track_temp_c ?? 0, focus: null });
    setups.set(session_id, { entries: [] });
    const stats = file.laps.map((l) => ({ ...l, lap_id: `${session_id.slice(0, 12)}-${pad3(l.lap_no)}` }));
    stintStats.set(session_id, stats);
    metaLaps.set(session_id, stats.map((l) => ({
      lap_id: l.lap_id, session_id, lap_no: l.lap_no, kind: l.kind,
      lap_time_s: l.lap_time_s !== null && l.lap_time_s > 0 ? l.lap_time_s : null, sectors_s: [],
      valid: l.valid, valid_override: null, pinned_reference: false, source: "own_recording",
      driver: "Driver", track_id: MONZA_TRACK_ID, car_id: CAR_720S.car_id, has_trace: false,
    })));
  }

  /**
   * The real Spa race of 10 Nov 2026 (9 laps, one stop; McLaren 720S GT3 Evo): every lap has its 1 m trace and its stint stats, and the
   * recording's own setup. Its in-car setting events and per-lap ABS / TC activation stay in the recording file (`setting_events`,
   * `aid_activation`, see recording.ts), for the session report. Lap kinds come from the stint stats; a lap without an official time
   * shows the elapsed time, as in the other sessions.
   */
  function addSpaRaceSession(rec: Recording, file: StintFile) {
    const session_id = fakeSha("spa-2026-11-10-race");
    const started_at = "2026-11-10T17:44:00";
    sessions.push({
      session_id, track_name: "Spa-Francorchamps", track_layout: "Grand Prix", track_id: SPA_TRACK_ID, track_length_m: SPA_TRACK_LENGTH_M,
      car_name: CAR_720S.car_name, car_id: CAR_720S.car_id, car_class: file.car_class, session_type: file.session_type,
      game_build: "1.2.0.3", started_at, driver: "Driver", steering_range_deg: rec.steering_range_deg, car_dims: DIMS_720S,
    });
    const d = new Date(started_at);
    dateLabel.set(session_id, `${d.getDate()} ${DATE_FMT[d.getMonth()]}`);
    extras.set(session_id, { trackTempC: file.laps[0]?.track_temp_c ?? 0, focus: null });
    setups.set(session_id, { entries: Object.entries(rec.car_setup ?? {}).map(([key, value]) => ({ key, label: setupLabel(key), value })) });
    const stats = file.laps.map((l) => ({ ...l, lap_id: `${session_id.slice(0, 12)}-${pad3(l.lap_no)}` }));
    stintStats.set(session_id, stats);
    if (rec.initial_settings && rec.setting_events) {
      settingLog.set(session_id, { initial: rec.initial_settings, events: rec.setting_events.map(({ setting, value, previous, lap_no, dist_m }) => ({ setting, value, previous, lap_no, dist_m })) });
    }
    for (const st of stats) {
      const recLap = rec.laps.find((x) => x.lap_no === st.lap_no);
      if (!recLap) continue;
      const official = st.lap_time_s !== null && st.lap_time_s > 0 ? st.lap_time_s : null;
      laps.set(st.lap_id, {
        trace: lapToTrace(recLap),
        meta: {
          lap_id: st.lap_id, session_id, lap_no: st.lap_no, kind: st.kind,
          lap_time_s: official ?? (st.lap_time_s === 0 ? recLap.t[recLap.t.length - 1] : null),
          sectors_s: official !== null && st.kind === "flying" && recLap.sectors_s ? fitSectors(recLap.sectors_s, official) : [],
          valid: st.valid, valid_override: null, pinned_reference: false, source: "own_recording",
          driver: "Driver", track_id: SPA_TRACK_ID, car_id: CAR_720S.car_id, has_trace: true,
        },
      });
    }
  }

  // The recordings are fetched on the first call of any method, never at import time.
  let ready: Promise<void> | null = null;
  const ensure = (): Promise<void> => {
    const tracks = (Object.keys(loaders) as RecordingTrack[]).filter((t) => loaders[t]);
    ready ??= Promise.all([
      Promise.all(tracks.map((t) => loaders[t]!())),
      loadElevation().catch(() => null),
      loadSurvey().catch(() => null),
      loadAerial().catch(() => null),
      loadStint().catch(() => null),
      loadSpaRace ? Promise.all([loadSpaRace(), loadSpaRaceStint()]).then(([rec, stint]) => (stint ? { rec, stint } : null)).catch(() => null) : null,
    ]).then(([loaded, elev, survey, aerial, stint, race]) => {
      elevationIndex = elev ? buildElevationIndex(elev) : null;
      surveyFile = survey;
      aerialFile = aerial;
      build(Object.fromEntries(tracks.map((t, i) => [t, loaded[i]])), stint, race);
    }).catch((e) => {
      ready = null;
      throw e instanceof ApiError ? e : new ApiError("network", e instanceof Error ? e.message : "could not load the recordings");
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
    if (!l && [...metaLaps.values()].some((ms) => ms.some((m) => m.lap_id === id))) {
      throw new ApiError("no_trace", `Lap ${id} has no 1 m trace: its session is known by lap metadata and stint stats only.`);
    }
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

  /** A comparison lap by id: a real lap, or the stitched ideal of a session (`ideal:<session_id>`). */
  const refOf = (refId: string, lap: LapRec): LapRec => {
    const sid = idealRefSession(refId);
    if (sid === null) return lapOf(refId);
    // The ideal belongs to the compared lap's own session.
    if (sid !== lap.meta.session_id) throw new ApiError("unknown_lap", `No ideal lap ${refId} for this lap: only its own session's ideal can be compared against.`);
    return idealRec(sid);
  };

  const resolveRef = (lap: LapRec, refId: string | null | undefined): LapRec => {
    const ref = refId ? refOf(refId, lap) : referenceFor(lap.meta.track_id, lap.meta.car_id);
    if (!ref) throw new ApiError("no_reference", "There is no lap to compare this lap with: there is no valid timed lap for this track and car.");
    if (ref.meta.track_id !== lap.meta.track_id) {
      throw new ApiError("track_mismatch", "These laps are from different track layouts and cannot be compared.");
    }
    return ref;
  };

  /**
   * The track's geometry on its own 1 m grid, built once: the centreline is the longest flying lap's line, the survey and
   * elevation (Spa only) are mapped onto it in full. (The mock has one capture and one survey per track, so "all laps" is the capture.)
   */
  const geometryCache = new Map<string, TrackGeometry>();
  const geometryOf = (trackId: string): TrackGeometry => {
    const hit = geometryCache.get(trackId);
    if (hit) return hit;
    const map = mapOf(trackId);
    const flying = [...laps.values()].filter((l) => l.meta.track_id === trackId && l.meta.kind === "flying");
    const line = flying.sort((x, y) => y.trace.distance.length - x.trace.distance.length)[0]?.trace.ch;
    if (!line) throw new ApiError("unknown_track", `No laps on ${trackId}, so no geometry`);
    const lat = Array.from(line.lat), lon = Array.from(line.lon);
    const isSpa = trackId === SPA_TRACK_ID;
    const survey = isSpa && surveyFile ? mapSurvey(surveyFile, lat, lon) : null;
    const share = (v: (number | null)[]) => (v.length ? v.filter((x) => x !== null).length / v.length : 0);
    const geometry: TrackGeometry = {
      track_id: trackId,
      length_m: map.length_m,
      centre: { lat, lon },
      elevation_m: isSpa && elevationIndex ? elevationProfile(elevationIndex, lat, lon) : null,
      survey,
      aerial: isSpa && aerialFile ? mapAerial(aerialFile, lat, lon) : null,
      coverage: survey ? { left: round3(share(survey.left_m)), right: round3(share(survey.right_m)) } : null,
      transform: {
        local: { kind: "equirectangular", earth_radius_m: EARTH_RADIUS_M, origin_lat_deg: 60, origin_lon_deg: 0 },
        real_world: null,
      },
    };
    geometryCache.set(trackId, geometry);
    return geometry;
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
    let refCh = cut(b.ch);
    if (ref.joins) {
      // A lap's grid ends a few ms before the line, so its raw end is `eps` short of its official time. The ideal's clock is official,
      // so give it the same shortfall, growing along the lap: the delta then ends at lap time minus ideal time, as the contract says.
      // An out or in lap has no official time: no shortfall to add.
      const eps = lapTime(lap) > 0 ? lapTime(lap) - lapCh.t[n - 1] : 0;
      refCh = { ...refCh, t: refCh.t.map((x, i) => x - (eps * i) / Math.max(1, n - 1)) };
    }
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
      lap_car_dims: sessionOf(lap.meta.session_id).car_dims,
      ref_car_dims: sessionOf(ref.meta.session_id).car_dims,
      lap_car_id: lap.meta.car_id,
      ref_car_id: ref.meta.car_id,
      lap_car_name: sessionOf(lap.meta.session_id).car_name,
      ref_car_name: sessionOf(ref.meta.session_id).car_name,
      corners: [],
      lap_balance: null, ref_balance: null,
      lap_understeer_runs: [], ref_understeer_runs: [], lap_oversteer_runs: [], ref_oversteer_runs: [],
      ref_joins_m: ref.joins ?? [],
    };
    // Same numbers the mock coach reads: cornerComparison builds them (the landmark list is not needed for the metrics).
    // Balance (vroom-bi4.5), calibrated on the two compared laps (one fit when they share a car and steering range).
    const bal = compareBalance(lapCh, refCh, res.lap_steering_range_deg, res.ref_steering_range_deg, lap.meta.car_id === ref.meta.car_id);
    if (bal.lap) {
      res.lap_balance = balanceForApi(bal.lap.balance);
      res.lap_understeer_runs = runsForApi(bal.lap.runs.understeer);
      res.lap_oversteer_runs = runsForApi(bal.lap.runs.oversteer);
    }
    if (bal.ref) {
      res.ref_balance = balanceForApi(bal.ref.balance);
      res.ref_understeer_runs = runsForApi(bal.ref.runs.understeer);
      res.ref_oversteer_runs = runsForApi(bal.ref.runs.oversteer);
    }
    const balances = { lap: res.lap_balance, ref: res.ref_balance };
    res.corners = mapOf(lap.meta.track_id).corners.map((c) => cornerComparison(c, lapCh, refCh, res.delta, [], balances).metrics);
    compareCache.set(key, res);
    return res;
  };

  const label = (r: LapRec) => {
    if (r.joins) return `Best possible lap ${formatLapTime(r.meta.lap_time_s!)}`;
    const tag = r.meta.kind === "flying" ? "" : ` (${r.meta.kind} lap)`;
    const time = r.meta.lap_time_s === null ? "—" : formatLapTime(r.meta.lap_time_s);
    return `${dateLabel.get(r.meta.session_id)} · L${r.meta.lap_no} ${time}${tag}`;
  };

  const withRef = (r: LapRec): LapWithRef => ({
    ...clone(r.meta),
    is_reference: referenceFor(r.meta.track_id, r.meta.car_id)?.meta.lap_id === r.meta.lap_id,
  });

  /**
   * The best time of each map segment over the valid flying laps in scope, and the lap it came from (the earliest on a tie).
   * Segments come from the track map as it is now, so this is computed on every call. The time is the sum of the segment times.
   */
  const ideal = (sessionId: string, scope: IdealScope): IdealLap => {
    const session = sessionOf(sessionId);
    const pool = [...laps.values()]
      .filter((l) => (scope === "all"
        ? l.meta.track_id === session.track_id && l.meta.car_id === session.car_id
        : l.meta.session_id === sessionId) && isTimed(l))
      .sort((a, b) => sessionOf(a.meta.session_id).started_at.localeCompare(sessionOf(b.meta.session_id).started_at) || a.meta.lap_no - b.meta.lap_no);
    if (!pool.length) throw new ApiError("no_valid_laps", "There is no valid timed lap to build an ideal lap from.");
    const segs = mapSegments(mapOf(session.track_id));
    const durs = pool.map((l) => segmentDurations(l.trace.ch.t, segs, lapTime(l)));
    const segments: IdealSegment[] = segs.map((s, k) => {
      let best = 0;
      for (let i = 1; i < pool.length; i++) if (durs[i][k] < durs[best][k]) best = i;
      const m = pool[best].meta;
      return { ...s, best_s: round3(durs[best][k]), lap_id: m.lap_id, lap_no: m.lap_no, session_id: m.session_id };
    });
    return { time_s: round3(segments.reduce((sum, s) => sum + s.best_s, 0)), scope, segments };
  };
  const theoreticalBest = (sessionId: string): number | null => {
    try {
      return ideal(sessionId, "session").time_s;
    } catch (e) {
      if (e instanceof ApiError && e.code === "no_valid_laps") return null;
      throw e;
    }
  };

  /**
   * The session's ideal lap as a lap of its own (`ideal:<session_id>`), stitched from the source laps segment by segment with the
   * same bounds as `ideal()`. Each segment keeps its source lap's channels but its clock is re-based: it starts where the previous
   * segment ended and lasts `best_s`, so `t` is continuous and ends at the ideal time. Joins sit at corner starts and ends, where
   * speed and line can jump (a stitched lap is not drivable, it is a yardstick). Cached per session; cleared when a lap's validity changes (it changes the pool).
   */
  const idealRecs = new Map<string, LapRec>();
  const idealRec = (sessionId: string): LapRec => {
    const hit = idealRecs.get(sessionId);
    if (hit) return hit;
    const ideal0 = ideal(sessionId, "session");
    const session = sessionOf(sessionId);
    const pool = sortedSessionLaps(sessionId).filter(isTimed);
    const n = Math.min(...pool.map((l) => l.trace.distance.length));
    const first = pool.find((l) => l.meta.lap_id === ideal0.segments[0].lap_id)!;
    const ch = {} as ChannelArrays;
    for (const k of GRID_CHANNELS) ch[k] = new Array<number>(n);
    let clock = 0;
    for (const seg of ideal0.segments) {
      const src = pool.find((l) => l.meta.lap_id === seg.lap_id)!;
      const st = src.trace.ch.t;
      const last = st.length - 1;
      // Official-time scale, like `segmentDurations`, so the segment lasts best_s.
      const scale = lapTime(src) > 0 && st[last] > st[0] ? lapTime(src) / (st[last] - st[0]) : 1;
      const at = (m: number) => st[Math.min(Math.round(m), last)];
      const isLast = seg === ideal0.segments[ideal0.segments.length - 1];
      const from = Math.min(Math.round(seg.start_m), n - 1), to = isLast ? n - 1 : Math.min(Math.round(seg.end_m) - 1, n - 1);
      for (let i = from; i <= to; i++) {
        for (const k of GRID_CHANNELS) ch[k][i] = k === "t" ? clock + (st[Math.min(i, last)] - at(seg.start_m)) * scale : src.trace.ch[k][Math.min(i, last)];
      }
      clock += seg.best_s;
    }
    // The grid ends a hair before the line, so the clock's end is a few ms off the ideal time: stretch it to land exactly on it.
    const tEnd = ch.t[n - 1];
    if (tEnd > 0) ch.t = ch.t.map((x) => (x * ideal0.time_s) / tEnd);
    const joins = ideal0.segments.slice(1).map((s) => s.start_m).filter((m) => m < n);
    const rec: LapRec = {
      joins,
      trace: { distance: first.trace.distance.slice(0, n), ch },
      meta: {
        ...clone(first.meta), lap_id: idealRefId(sessionId), lap_no: 0, kind: "flying", lap_time_s: ideal0.time_s,
        sectors_s: [], valid: true, valid_override: null, pinned_reference: false, session_id: session.session_id,
      },
    };
    idealRecs.set(sessionId, rec);
    return rec;
  };

  const delay = (ms: number) => (ms > 0 ? new Promise<void>((res) => setTimeout(res, ms)) : Promise.resolve());

  // -- coach --

  const comparisons = (map: TrackMap, cmp: CompareResponse): CornerComparison[] =>
    map.corners.map((c) => cornerComparison(c, cmp.lap, cmp.ref, cmp.delta, map.landmarks, { lap: cmp.lap_balance, ref: cmp.ref_balance }));

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
      if (valid.length < 2) throw new ApiError("not_enough_laps", "Checking consistency needs at least 2 valid timed laps in the session.");
      const ref = req.ref_lap_id ? refOf(req.ref_lap_id, lap) : referenceFor(lap.meta.track_id, lap.meta.car_id);
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
        summary: `${f.corner.name}: ${signed(f.delta)} against your best lap.`,
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
          : `${signed(total)} against your best lap.${issues.length ? ` It goes at ${issues.map((f) => f.corner.name).join(", ")}.` : ""}`,
      findings,
      focus: top ? { corner_id: top.corner.id, instruction: findings[0].fix, metric: METRIC[built[0].cause] } : null,
      encouragement: strength ? `${strength.corner.name} is quicker than your best lap. Keep that commitment.` : null,
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
      const metaOnly = metaLaps.get(sessionId);
      if (metaOnly) return metaOnly.map((m) => ({ ...clone(m), is_reference: false }));
      return sortedSessionLaps(sessionId).map(withRef);
    },
    async lap(lapId) {
      for (const ms of metaLaps.values()) {
        const m = ms.find((x) => x.lap_id === lapId);
        if (m) return { ...clone(m), is_reference: false };
      }
      return withRef(lapOf(lapId));
    },
    async patchLap(lapId, patch) {
      const lap = lapOf(lapId);
      if (patch.valid_override !== undefined) {
        lap.meta.valid_override = patch.valid_override;
        // Validity decides which laps the ideal is stitched from: drop the stitched laps and their comparisons.
        idealRecs.clear();
        for (const k of [...compareCache.keys()]) if (k.includes(`|${IDEAL_REF_PREFIX}`)) compareCache.delete(k);
      }
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
      const idealCand = (): CompareCandidate[] => {
        try {
          const ir = idealRec(lap.meta.session_id);
          return [{
            lap_id: ir.meta.lap_id, label: `Best possible lap ${formatLapTime(ir.meta.lap_time_s!)}`, lap_time_s: ir.meta.lap_time_s,
            car_name: sessionOf(lap.meta.session_id).car_name, is_reference: false, is_previous: false, other_car: false, is_ideal: true,
          }];
        } catch (e) {
          if (e instanceof ApiError && e.code === "no_valid_laps") return [];
          throw e;
        }
      };
      return [...idealCand(), ...[...laps.values()]
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
          is_ideal: false,
        }))];
    },
    async trackMap(trackId) {
      return clone(mapOf(trackId));
    },
    async trackGeometry(trackId) {
      await ensure();
      return clone(geometryOf(trackId));
    },
    async addLandmark(trackId, landmark) {
      const m = mapOf(trackId);
      let id: string;
      do id = `lm-${++counter}`; while (m.landmarks.some((l) => l.id === id));
      m.landmarks.push({
        label: landmark.label, kind: landmark.kind, distance_m: landmark.distance_m, corner_id: landmark.corner_id,
        id, confidence: "confirmed",
      });
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
      const metaOnly = metaLaps.get(sessionId);
      const recs = metaOnly ? metaOnly.map((meta) => ({ meta })) : sortedSessionLaps(sessionId);
      const valid = recs.filter((r) => r.meta.kind === "flying" && effectiveValid(r.meta) && (r.meta.lap_time_s ?? 0) > 0);
      const x = extras.get(sessionId)!;
      return {
        n_laps: recs.length,
        n_valid: valid.length,
        best_lap_s: valid.length ? Math.min(...valid.map((r) => r.meta.lap_time_s ?? 0)) : null,
        theoretical_best_s: theoreticalBest(sessionId),
        track_temp_c: x.trackTempC,
        focus: clone(x.focus),
      };
    },
    async sessionSetup(sessionId): Promise<CarSetup> {
      sessionOf(sessionId);
      return clone(setups.get(sessionId)!);
    },
    async idealLap(sessionId, scope = "session") {
      return clone(ideal(sessionId, scope));
    },
    async segmentTimes(sessionId): Promise<SegmentTimes> {
      const session = sessionOf(sessionId);
      const pool = sortedSessionLaps(sessionId).filter(isTimed);
      if (!pool.length) throw new ApiError("no_valid_laps", "There is no valid timed lap in this session.");
      const segs = mapSegments(mapOf(session.track_id));
      return { laps: pool.map((l) => ({ lap_id: l.meta.lap_id, lap_no: l.meta.lap_no, segment_s: segmentDurations(l.trace.ch.t, segs, lapTime(l)).map(round3) })) };
    },
    async calibrate(trackId): Promise<CalibrationResult> {
      const m = mapOf(trackId);
      const onTrack = [...laps.values()].filter((l) => l.meta.track_id === trackId);
      const ref = onTrack.find((l) => l.meta.pinned_reference) ?? onTrack.filter(isTimed).sort((a, b) => lapTime(a) - lapTime(b))[0];
      if (!ref) throw new ApiError("no_reference", "Calibration needs a best lap to compare with, and this track has none.");
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
    async sessionStints(sessionId): Promise<Stint[]> {
      return splitStints(clone(stintStats.get(sessionId) ?? []), sessionOf(sessionId).car_class);
    },
    async sessionReport(sessionId): Promise<SessionReport> {
      const session = sessionOf(sessionId);
      const metas = metaLaps.get(sessionId) ?? sortedSessionLaps(sessionId).map((l) => l.meta);
      const stats = stintStats.get(sessionId) ?? null;
      const corners = mapOf(session.track_id).corners;
      const traces = new Map<number, TraceFacts>();
      const aid = new Map<number, { abs_m: number; tc_m: number }>();
      for (const rec of sortedSessionLaps(sessionId)) {
        const ch = rec.trace.ch;
        const idx = (m: number) => Math.min(ch.t.length - 1, Math.max(0, Math.round(m)));
        const aids = aidRuns(ch);
        traces.set(rec.meta.lap_no, { aids, corner_times_s: corners.map((c) => ch.t[idx(c.end_m)] - ch.t[idx(c.start_m)]) });
        const metres = (runs: { start: number; end: number }[]) => runs.reduce((a, x) => a + x.end - x.start + 1, 0);
        aid.set(rec.meta.lap_no, { abs_m: metres(aids.abs), tc_m: metres(aids.tc) });
      }
      return clone(buildSessionReport({
        session_id: sessionId, car_class: session.car_class, track_length_m: session.track_length_m,
        laps: metas.map((m) => ({ lap_id: m.lap_id, lap_no: m.lap_no, kind: m.kind, lap_time_s: m.lap_time_s, valid: effectiveValid(m), has_trace: m.has_trace })),
        stats, stints: stats ? splitStints(clone(stats), session.car_class) : [],
        settings: settingLog.get(sessionId) ?? null, corners, traces, aid_activation: aid,
      }));
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
