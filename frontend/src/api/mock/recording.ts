// The real recordings served from /mock (Spa, Monza), and the conversion to the app's grid channels.
// Each JSON is fetched on first use (never imported into the bundle) and every lap is converted once.
import type { ChannelArrays } from "../types";

export interface RecordingLap {
  lap_no: number;
  start_ts: number;
  end_ts: number;
  /** null: no official time (out/in lap); 0: invalid lap. */
  lap_time_s: number | null;
  /** Real [sector 1, 2, 3] durations from LMU's Last Sector1/2 events; null on an invalid, out or in lap. Older files lack it. */
  sectors_s?: number[] | null;
  length_m: number;
  t: number[];
  speed_kmh: number[];
  throttle: number[];
  brake: number[];
  steering: number[];
  gear: number[];
  rpm: number[];
  g_lat: number[];
  g_long: number[];
  lat: number[];
  lon: number[];
  path_lateral: number[];
  track_edge: number[];
  kerb: number[];
  /** Driver aids and tyre slip (vroom-pnw.14); absent in recordings made before the extractor wrote them. */
  abs?: number[];
  tc?: number[];
  slip_fl?: number[];
  slip_fr?: number[];
  slip_rl?: number[];
  slip_rr?: number[];
  /** Wheels on grass or gravel, 0..4 (vroom-pnw.24); absent in older recordings. */
  wheels_off?: number[];
  /** Metres with ABS / TC on and the number of separate activations in this lap (vroom-bi4.10); absent in older files. */
  aid_activation?: AidActivation;
}

/** Per-lap driver-aid activation, from the lap's own `abs` / `tc` metres. `*_m` counts metres, `*_runs` counts separate on-stretches. */
export interface AidActivation {
  abs_m: number;
  tc_m: number;
  abs_runs: number;
  tc_runs: number;
}

/** The in-car settings LMU records as change events (the recording's ABSLevel, TCLevel, TCCut, TCSlipAngle and FuelMixtureMap events). */
export type SettingName = "ABSLevel" | "TCLevel" | "TCCut" | "TCSlipAngle" | "FuelMixtureMap";

/**
 * One in-car setting change (vroom-bi4.10). `value` / `previous` are LMU's setting values (the knob position, unitless). `lap_no` is the
 * lap the change happened in (the recording's lap number), `dist_m` the lap distance in metres where it happened (it can pass the lap
 * length in the pit lane, where LMU's Lap Dist keeps counting) and `lap_time_s` the seconds since that lap started. Sorted by lap, then time.
 */
export interface SettingEvent {
  setting: SettingName;
  value: number;
  previous: number;
  lap_no: number;
  dist_m: number;
  lap_time_s: number;
}

export interface Recording {
  source: string;
  note?: string;
  steering_range_deg: number | null;
  /** The recording's garage setup: LMU key -> display string. Absent in files made before vroom-pnw.25. */
  car_setup?: Record<string, string>;
  /** The value of each in-car setting at the recording start (vroom-bi4.10). Absent in older files. */
  initial_settings?: Partial<Record<SettingName, number>>;
  /** Every change of those settings after the start (vroom-bi4.10). Absent in older files. */
  setting_events?: SettingEvent[];
  laps: RecordingLap[];
}

export type RecordingLoader = () => Promise<Recording>;

export interface Trace {
  distance: number[];
  ch: ChannelArrays;
}

/** The tracks the mock has a real recording for, and where each one is served. */
export const RECORDING_URLS = {
  spa: "/mock/spa-2026-11-03.json",
  monza: "/mock/monza-2026-11-05.json",
} as const;

export type RecordingTrack = keyof typeof RECORDING_URLS;

/** The Spa race of 10 Nov 2026: every lap with its 1 m trace, plus setting events and aid activation (vroom-bi4.10). */
export const SPA_RACE_URL = "/mock/spa-race-2026-11-10.json";

let spaRace: Promise<Recording> | null = null;

/** Default browser loader for the Spa race: one fetch, cached for the page's lifetime (a failure is not cached). */
export const fetchSpaRace: RecordingLoader = () => {
  if (!spaRace) {
    spaRace = fetch(SPA_RACE_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${SPA_RACE_URL}: HTTP ${res.status}`);
        return res.json() as Promise<Recording>;
      })
      .catch((e) => {
        spaRace = null;
        throw e;
      });
  }
  return spaRace;
};

const cached = new Map<RecordingTrack, Promise<Recording>>();

/** Default browser loader for one track: one fetch, cached for the page's lifetime (a failure is not cached). */
export function fetchRecording(track: RecordingTrack): Promise<Recording> {
  let hit = cached.get(track);
  if (!hit) {
    const url = RECORDING_URLS[track];
    hit = fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
        return res.json() as Promise<Recording>;
      })
      .catch((e) => {
        cached.delete(track);
        throw e;
      });
    cached.set(track, hit);
  }
  return hit;
}

/** All 26 grid channels for one recorded lap. yaw_rate is derived from lateral g and speed; suspension is not recorded (zeros). A recording without aid channels gets no aids and slip 1. */
export function lapToTrace(lap: RecordingLap): Trace {
  const n = lap.t.length;
  const zeros = new Array<number>(n).fill(0);
  const ones = new Array<number>(n).fill(1);
  const yaw = lap.g_lat.map((g, i) => (g * 9.81) / Math.max(lap.speed_kmh[i] / 3.6, 5));
  return {
    distance: Array.from({ length: n }, (_, i) => i),
    ch: {
      t: lap.t, speed_kmh: lap.speed_kmh, throttle: lap.throttle, brake: lap.brake, steering: lap.steering,
      gear: lap.gear, rpm: lap.rpm, g_lat: lap.g_lat, g_long: lap.g_long, yaw_rate: yaw,
      lat: lap.lat, lon: lap.lon, path_lateral: lap.path_lateral, track_edge: lap.track_edge, kerb: lap.kerb,
      susp_fl: zeros, susp_fr: zeros, susp_rl: zeros, susp_rr: zeros,
      abs: lap.abs ?? zeros, tc: lap.tc ?? zeros,
      slip_fl: lap.slip_fl ?? ones, slip_fr: lap.slip_fr ?? ones, slip_rl: lap.slip_rl ?? ones, slip_rr: lap.slip_rr ?? ones,
      wheels_off: lap.wheels_off ?? zeros,
    },
  };
}

/** Same lap with `t` multiplied by target / original (original = the lap's own final t). Other channels are shared, read-only. */
export function scaleTime(trace: Trace, targetS: number): Trace {
  const t = trace.ch.t;
  const f = targetS / t[t.length - 1];
  const scaled = t.map((x) => x * f);
  scaled[scaled.length - 1] = targetS; // exact, whatever the float rounding
  return { distance: trace.distance, ch: { ...trace.ch, t: scaled } };
}
