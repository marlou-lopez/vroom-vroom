// Car attitude (heading, pitch, roll) estimated from what a recording has: GPS line, road heights and G forces.
// LMU recordings carry no orientation channel, so the cockpit camera (#100) uses this estimate. The gains were fitted and
// checked against the exact orientation of a shared-memory capture of the same session: see
// tools/lmu-logger/attitude_check.py and docs/track-views/cockpit-view.md for the method and the error numbers.
//
// Sign conventions (all angles in radians):
//   heading  0 = east, +pi/2 = north (counter-clockwise from above), the direction of travel.
//   pitch    positive = nose up.
//   roll     positive = leaning right (the right side lower), seen from the driver's seat.
// Input grid channels (CompareResponse.lap, one value per metre) as the mock and the extractor produce them:
//   g_lat    positive = turning LEFT (the car is pushed to the left; a left turn has the centripetal acceleration on the left).
//   g_long   positive = BRAKING (decelerating), negative = accelerating. (LMU's raw channels are swapped; the extractor fixes
//            the names, not the signs.)
import type { XY } from "./geo";

const DEG = Math.PI / 180;

/** The direction of travel is the chord of the line from this many metres behind to this many ahead (fitted: smallest slip, still smooth). */
export const HEADING_HALF_M = 5;
/** Road slope is the height change over this many metres each side of the car, as in the 3D view's car pose. */
export const SLOPE_HALF_M = 3;
/** Moving-average half width (metres) that takes the vibration off the G channels. */
export const G_SMOOTH_HALF_M = 4;

/** Nose attitude with no longitudinal g: the car sits slightly nose-down against the road slope (rake, aero load). Radians. */
export const PITCH_REST = -0.22 * DEG;
/** Pitch change per g of braking (negative: braking dives the nose, accelerating squats it). Radians per g. */
export const K_PITCH = -0.294 * DEG;
/**
 * Body roll per g of left-turning lateral acceleration (positive: a left turn leans the car right, i.e. the body rolls to the
 * outside). Radians per g. This is the physical gain, fitted on the same metre of road over three laps so that the road's
 * banking drops out. The banking itself comes in through the `bank` input (the track survey's `bank_deg`); without it the
 * roll is body roll only. Keep equal to K_ROLL_DEG in tools/lmu-logger/decode.py.
 */
export const K_ROLL = 0.476 * DEG;
/** Moving-average half width (metres) that takes the noise off the surveyed road bank. */
export const BANK_SMOOTH_HALF_M = 4;

export interface Attitude {
  /** Direction of travel per grid metre. */
  heading: Float64Array;
  /** Pitch of the road along the line (unexaggerated). */
  slope: Float64Array;
  /** Pitch relative to the road from longitudinal g (nose up positive). */
  dive: Float64Array;
  /** Roll per grid metre. */
  roll: Float64Array;
  /** slope + dive: the car's pitch in the world. */
  pitch: Float64Array;
}

export interface AttitudeInput {
  line: XY;
  /** Road height per grid metre (the last height holds when shorter than the line). */
  heights: ArrayLike<number>;
  gLat: ArrayLike<number>;
  gLong: ArrayLike<number>;
  /** Road banking per grid metre (radians, right side lower positive), added to the roll; null, NaN or missing = unknown, taken as flat. Absent = flat road. */
  bank?: ArrayLike<number | null>;
}

/** Moving average of half width `half` (the window shrinks at the ends); NaN and missing values count as 0. */
function movingAverage(v: ArrayLike<number | null>, n: number, half: number): Float64Array {
  const out = new Float64Array(n);
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    const x = v[i];
    prefix[i + 1] = prefix[i] + (typeof x === "number" && Number.isFinite(x) ? x : 0);
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half), hi = Math.min(n - 1, i + half);
    out[i] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1);
  }
  return out;
}

/** Estimated attitude per grid metre of a lap. The length is that of the shortest input channel. */
export function estimateAttitude(inp: AttitudeInput): Attitude {
  const { line, heights } = inp;
  const n = Math.min(line.x.length, line.y.length, inp.gLat.length, inp.gLong.length);
  const heading = new Float64Array(n), slope = new Float64Array(n), dive = new Float64Array(n);
  const roll = new Float64Array(n), pitch = new Float64Array(n);
  const hAt = (i: number) => (heights.length === 0 ? 0 : heights[Math.min(i, heights.length - 1)]);
  const gLat = movingAverage(inp.gLat, n, G_SMOOTH_HALF_M), gLong = movingAverage(inp.gLong, n, G_SMOOTH_HALF_M);
  const bank = inp.bank ? movingAverage(inp.bank, n, BANK_SMOOTH_HALF_M) : null;
  for (let i = 0; i < n; i++) {
    const a = Math.max(i - HEADING_HALF_M, 0), b = Math.min(i + HEADING_HALF_M, n - 1);
    heading[i] = b > a ? Math.atan2(line.y[b] - line.y[a], line.x[b] - line.x[a]) : 0;
    const sa = Math.max(i - SLOPE_HALF_M, 0), sb = Math.min(i + SLOPE_HALF_M, n - 1);
    const run = Math.hypot(line.x[sb] - line.x[sa], line.y[sb] - line.y[sa]);
    slope[i] = run > 0.1 ? Math.atan2(hAt(sb) - hAt(sa), run) : 0;
    dive[i] = PITCH_REST + K_PITCH * gLong[i];
    roll[i] = K_ROLL * gLat[i] + (bank ? bank[i] : 0);
    pitch[i] = slope[i] + dive[i];
  }
  return { heading, slope, dive, roll, pitch };
}

/** Attitude at fractional grid distance `d` (linear between metres; the heading takes the short way round). */
export interface AttitudeAt { heading: number; slope: number; dive: number; roll: number }

export function attitudeAt(a: Attitude, d: number): AttitudeAt {
  const n = a.heading.length;
  if (n === 0) return { heading: 0, slope: 0, dive: 0, roll: 0 };
  const f = Math.min(Math.max(d, 0), n - 1);
  const i = Math.min(Math.floor(f), n - 1), j = Math.min(i + 1, n - 1), t = f - i;
  const lerp = (v: Float64Array) => v[i] + (v[j] - v[i]) * t;
  let dh = a.heading[j] - a.heading[i];
  dh -= Math.round(dh / (2 * Math.PI)) * 2 * Math.PI;
  return { heading: a.heading[i] + dh * t, slope: lerp(a.slope), dive: lerp(a.dive), roll: lerp(a.roll) };
}
