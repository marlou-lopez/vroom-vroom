// The real Spa recording served at /mock/spa-2026-11-03.json, and the conversion to the app's grid channels.
// The JSON is fetched on first use (never imported into the bundle) and every lap is converted once.
import type { ChannelArrays } from "../types";

export interface SpaRecordingLap {
  lap_no: number;
  start_ts: number;
  end_ts: number;
  /** null: no official time (out/in lap); 0: invalid lap. */
  lap_time_s: number | null;
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
}

export interface SpaRecording {
  source: string;
  note: string;
  steering_range_deg: number | null;
  laps: SpaRecordingLap[];
}

export type SpaLoader = () => Promise<SpaRecording>;

export interface Trace {
  distance: number[];
  ch: ChannelArrays;
}

export const SPA_RECORDING_URL = "/mock/spa-2026-11-03.json";

let cached: Promise<SpaRecording> | null = null;

/** Default browser loader: one fetch, cached for the page's lifetime (a failure is not cached). */
export const fetchSpaRecording: SpaLoader = () => {
  if (!cached) {
    cached = fetch(SPA_RECORDING_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${SPA_RECORDING_URL}: HTTP ${res.status}`);
        return res.json() as Promise<SpaRecording>;
      })
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
};

/** All 19 grid channels for one recorded lap. yaw_rate is derived from lateral g and speed; suspension is not recorded (zeros). */
export function lapToTrace(lap: SpaRecordingLap): Trace {
  const n = lap.t.length;
  const zeros = new Array<number>(n).fill(0);
  const yaw = lap.g_lat.map((g, i) => (g * 9.81) / Math.max(lap.speed_kmh[i] / 3.6, 5));
  return {
    distance: Array.from({ length: n }, (_, i) => i),
    ch: {
      t: lap.t, speed_kmh: lap.speed_kmh, throttle: lap.throttle, brake: lap.brake, steering: lap.steering,
      gear: lap.gear, rpm: lap.rpm, g_lat: lap.g_lat, g_long: lap.g_long, yaw_rate: yaw,
      lat: lap.lat, lon: lap.lon, path_lateral: lap.path_lateral, track_edge: lap.track_edge, kerb: lap.kerb,
      susp_fl: zeros, susp_fr: zeros, susp_rl: zeros, susp_rr: zeros,
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
