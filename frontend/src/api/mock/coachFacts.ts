// Pure per-corner facts and the data-driven finding templates of the mock coach.
// Every number quoted comes from the two laps. Positions are described against landmarks, never as metre distances.
import { causeOf, type Cause } from "../../lib/cornerCause";
import { describeAgainst, offsetPhrase } from "../../lib/landmarkPhrase";

export { describeAgainst, offsetPhrase };
import type { ChannelArrays, Corner, CornerMetrics, CornerSideMetrics, CueType, Landmark } from "../types";

type Signals = Pick<ChannelArrays, "t" | "speed_kmh" | "throttle" | "brake" | "steering">;

export interface CornerSide {
  minSpeed: number;
  minIdx: number;
  exitSpeed: number;
  brakeOnset: number | null;
  peakBrake: number;
  throttlePickup: number | null;
  /** Seconds with neither pedal pressed (throttle and brake < 0.05) above 50 km/h. */
  coastS: number;
  /** Seconds with both pedals pressed (throttle and brake > 0.1). */
  overlapS: number;
  /** Steering extrema in the corner (see steeringExtrema); compare against the reference's count. */
  steerExtrema: number;
}

export interface CornerComparison {
  corner: Corner;
  delta: number;
  lap: CornerSide;
  ref: CornerSide;
  /** Landmarks with confidence detected or confirmed that belong to this corner. */
  anchors: Landmark[];
  /** The same numbers in the API's shape (`CompareResponse.corners`); the coach reads its cause scoring from here. */
  metrics: CornerMetrics;
}

export type { Cause };

export { causeOf };

export interface Narrative {
  what: string;
  fix: string;
  cue: CueType;
  evidence: string[];
  cause: Cause;
}

const STEER_PROMINENCE = 0.1;
const STEER_SMOOTH_M = 5;
const THROTTLE_PICKUP = 0.5;

/**
 * The grid indices of a corner in driving order, each with its unwrapped position `u` (metres along the corner's own run).
 * A corner that wraps over the start line (start > end, #5) runs to the last index and continues at 0; `u` keeps growing across it.
 */
function cornerWalk(corner: Corner, last: number): { i: number; u: number }[] {
  const s = Math.min(Math.round(corner.start_m), last);
  const e = Math.min(Math.round(corner.end_m), last);
  const out: { i: number; u: number }[] = [];
  if (s <= e) {
    for (let i = s; i <= e; i++) out.push({ i, u: i });
    return out;
  }
  for (let i = s; i <= last; i++) out.push({ i, u: i });
  for (let i = 0; i <= e; i++) out.push({ i, u: i + last });
  return out;
}

/** Centred moving average of +-5 samples (1 m grid) at the given indices: shrinks at the array ends, or wraps over them when `wrap`. */
function smooth(a: ArrayLike<number>, idx: number[], wrap: boolean): number[] {
  const n = a.length;
  return idx.map((i) => {
    let sum = 0;
    let cnt = 0;
    for (let d = -STEER_SMOOTH_M; d <= STEER_SMOOTH_M; d++) {
      let j = i + d;
      if (wrap) j = ((j % n) + n) % n;
      else if (j < 0 || j >= n) continue;
      sum += a[j];
      cnt++;
    }
    return sum / cnt;
  });
}

/** Local extrema of the smoothed steering inside [start, end] (start > end: over the start line) whose prominence is >= 10 % of the corner's max |smoothed steering|. */
export function steeringExtrema(steering: ArrayLike<number>, start: number, end: number): number {
  const last = steering.length - 1;
  const corner = { start_m: start, end_m: end } as Corner;
  const v = smooth(steering, cornerWalk(corner, last).map((w) => w.i), start > end);
  const thr = STEER_PROMINENCE * Math.max(...v.map(Math.abs));
  if (!(thr > 0)) return 0;
  let dir = 0;
  let ext = v[0];
  let count = 0;
  for (let i = 1; i < v.length; i++) {
    const x = v[i];
    if (dir === 0) {
      if (x - ext >= thr) { dir = 1; ext = x; }
      else if (ext - x >= thr) { dir = -1; ext = x; }
    } else if (dir === 1) {
      if (x > ext) ext = x;
      else if (ext - x >= thr) { dir = -1; count++; ext = x; }
    } else if (x < ext) ext = x;
    else if (x - ext >= thr) { dir = 1; count++; ext = x; }
  }
  return count;
}

/** Corrections relative to the reference lap: extra extrema over the reference's own count (its natural left-right cancels out). */
export function steeringCorrections(lap: ArrayLike<number>, ref: ArrayLike<number>, start: number, end: number): number {
  return Math.max(0, steeringExtrema(lap, start, end) - steeringExtrema(ref, start, end));
}

const BRAKE_ONSET = 0.1;
const COAST_PEDAL = 0.05;
const COAST_MIN_KMH = 50;
const OVERLAP_PEDAL = 0.1;

export function cornerSide(ch: Signals, corner: Corner): CornerSide {
  const last = ch.speed_kmh.length - 1;
  const walk = cornerWalk(corner, last);
  const wraps = corner.start_m > corner.end_m;
  const apexU = wraps && corner.apex_m <= corner.end_m ? corner.apex_m + last : corner.apex_m;
  let minK = 0;
  let peakBrake = 0;
  let onset: number | null = null;
  walk.forEach(({ i, u }, k) => {
    if (ch.speed_kmh[i] < ch.speed_kmh[walk[minK].i]) minK = k;
    peakBrake = Math.max(peakBrake, ch.brake[i]);
    if (onset === null && u <= apexU && ch.brake[i] >= BRAKE_ONSET) onset = i;
  });
  let pickup: number | null = null;
  for (let k = minK; k < walk.length; k++) {
    if (ch.throttle[walk[k].i] >= THROTTLE_PICKUP) { pickup = walk[k].i; break; }
  }
  // Time spent per grid step; the step off the last sample (over the start line) reuses the one before it.
  const dt = (i: number) => (i < last ? ch.t[i + 1] - ch.t[i] : last > 0 ? ch.t[last] - ch.t[last - 1] : 0);
  let coastS = 0;
  let overlapS = 0;
  for (let k = 0; k < walk.length - 1; k++) {
    const i = walk[k].i;
    const [thr, brk] = [ch.throttle[i], ch.brake[i]];
    if (thr < COAST_PEDAL && brk < COAST_PEDAL && ch.speed_kmh[i] > COAST_MIN_KMH) coastS += dt(i);
    if (thr > OVERLAP_PEDAL && brk > OVERLAP_PEDAL) overlapS += dt(i);
  }
  const minIdx = walk[minK].i;
  return {
    minSpeed: ch.speed_kmh[minIdx], minIdx, exitSpeed: ch.speed_kmh[walk[walk.length - 1].i], brakeOnset: onset, peakBrake,
    throttlePickup: pickup, coastS, overlapS,
    steerExtrema: steeringExtrema(ch.steering, walk[0].i, walk[walk.length - 1].i),
  };
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;

const sideMetrics = (s: CornerSide): CornerSideMetrics => ({
  brake_onset_m: s.brakeOnset, peak_brake: r3(s.peakBrake), min_speed_kmh: r1(s.minSpeed), min_speed_m: s.minIdx,
  throttle_pickup_m: s.throttlePickup, exit_speed_kmh: r1(s.exitSpeed), coast_s: r3(s.coastS), overlap_s: r3(s.overlapS),
  steer_corrections: s.steerExtrema,
});

/** Change of a grid series between a corner's start and end; over the start line for a wrapping corner. */
export function cornerChange(series: ArrayLike<number>, corner: Corner): number {
  const last = series.length - 1;
  const s = Math.min(Math.round(corner.start_m), last);
  const e = Math.min(Math.round(corner.end_m), last);
  return s <= e ? series[e] - series[s] : series[last] - series[s] + series[e] - series[0];
}

export const isUsable = (l: Landmark) => l.confidence !== "low";

export function cornerComparison(
  corner: Corner, lap: Signals, ref: Signals, delta: ArrayLike<number>, landmarks: Landmark[],
): CornerComparison {
  const d = cornerChange(delta, corner);
  const [lapSide, refSide] = [cornerSide(lap, corner), cornerSide(ref, corner)];
  return {
    corner, delta: d, lap: lapSide, ref: refSide,
    anchors: landmarks.filter((l) => l.corner_id === corner.id && isUsable(l)),
    metrics: { corner_id: corner.id, delta_s: r3(d), lap: sideMetrics(lapSide), ref: sideMetrics(refSide) },
  };
}

// ---- wording ----

const n0 = (x: number) => x.toFixed(0);
/** "112 / 118", or with one decimal when whole km/h would print the same number twice. */
const pair = (a: number, b: number) => (n0(a) === n0(b) ? `${a.toFixed(1)} / ${b.toFixed(1)}` : `${n0(a)} / ${n0(b)}`);

function apexDesc(pos: number, apex: number): string {
  return `${offsetPhrase(pos - apex)} the apex`;
}

export function narrate(c: CornerComparison, kind: "issue" | "minor" | "strength"): Narrative {
  const { lap, ref, corner } = c;
  const apexKerb = c.anchors.filter((a) => a.kind === "kerb_apex");
  const brakeLap = lap.brakeOnset !== null ? describeAgainst(lap.brakeOnset, c.anchors) : null;
  const brakeRef = ref.brakeOnset !== null ? describeAgainst(ref.brakeOnset, c.anchors) : null;
  const thrAnchors = apexKerb.length ? apexKerb : [];
  const thrDesc = (pos: number | null) =>
    pos === null ? null : describeAgainst(pos, thrAnchors) ?? apexDesc(pos, corner.apex_m);
  const thrLap = thrDesc(lap.throttlePickup);
  const thrRef = thrDesc(ref.throttlePickup);
  // Where the minimum is only means something close to the apex (a flat-out corner has its minimum at the window edge).
  const where = (side: CornerSide) => (Math.abs(side.minIdx - corner.apex_m) <= 100 ? apexDesc(side.minIdx, corner.apex_m) : null);
  const [whereLap, whereRef] = [where(lap), where(ref)];
  const [speedA, speedB] = pair(lap.minSpeed, ref.minSpeed).split(" / ");
  const speeds = `${speedA} km/h against ${speedB} on the reference`;
  const steerDiff = lap.steerExtrema - ref.steerExtrema;
  const braked = lap.peakBrake >= 0.05 || ref.peakBrake >= 0.05;

  const evidence = {
    speed: whereLap && whereRef
      ? `min speed ${n0(lap.minSpeed)} km/h (${whereLap}) / ${n0(ref.minSpeed)} km/h (${whereRef})`
      : `min speed ${pair(lap.minSpeed, ref.minSpeed)} km/h`,
    brake: brakeLap && brakeRef
      ? `brake onset ${brakeLap} / ${brakeRef}`
      : braked ? `peak brake ${(lap.peakBrake * 100).toFixed(0)}% / ${(ref.peakBrake * 100).toFixed(0)}%` : null,
    throttle: thrLap && thrRef ? `throttle pickup ${thrLap} / ${thrRef}` : null,
    steering: steerDiff !== 0 ? `${Math.abs(steerDiff)} ${steerDiff > 0 ? "more" : "fewer"} steering corrections than the reference` : null,
    exit: `exit speed ${pair(lap.exitSpeed, ref.exitSpeed)} km/h`,
  };
  const pack = (first: keyof typeof evidence): string[] => {
    const order = [first, "speed", "brake", "throttle", "steering", "exit"] as const;
    return [...new Set(order)].map((k) => evidence[k]).filter((x): x is string => !!x).slice(0, 3);
  };

  if (kind === "strength") {
    const faster = lap.minSpeed - ref.minSpeed >= 1;
    const parts: string[] = [];
    if (faster) parts.push(`minimum speed ${speeds}`);
    if (steerDiff <= -2) parts.push(`${-steerDiff} fewer steering corrections than the reference`);
    if (thrLap && thrRef && lap.throttlePickup! < ref.throttlePickup! - 15) parts.push(`throttle pickup ${thrLap} (the reference ${thrRef})`);
    if (!parts.length) {
      const [a, b] = pair(lap.exitSpeed, ref.exitSpeed).split(" / ");
      parts.push(`exit speed ${a} km/h against ${b} on the reference`);
    };
    return {
      what: `Quicker than the reference through ${corner.name}: ${parts.join(", ")}.`,
      fix: "Keep it.", cue: "none", evidence: pack(faster ? "speed" : "exit"), cause: "speed",
    };
  }

  const cause = causeOf(c.metrics);
  const slower = ref.minSpeed - lap.minSpeed >= 1;
  const speedClause = slower ? `, and the minimum speed is ${speeds}` : "";
  const exitClause = lap.exitSpeed < ref.exitSpeed - 1 ? `, and you leave at ${n0(lap.exitSpeed)} km/h against ${n0(ref.exitSpeed)}` : "";
  const minor = kind === "minor";
  switch (cause) {
    case "brake": {
      const earlier = lap.brakeOnset! < ref.brakeOnset!;
      const cmp = brakeLap && brakeRef ? ` (${brakeLap}; the reference brakes ${brakeRef})` : "";
      const fix = brakeRef
        ? `Brake ${brakeRef} and hold that reference every lap.`
        : earlier
          ? "Brake a little later and pick one fixed trackside reference for the braking point."
          : "Brake a little earlier and pick one fixed trackside reference for the braking point.";
      return {
        what: `You start braking ${earlier ? "earlier" : "later"} than the reference${cmp}${speedClause}.`,
        fix, cue: brakeRef ? "landmark" : "feel", evidence: pack("brake"), cause,
      };
    }
    case "throttle": {
      const cmp = thrLap && thrRef ? ` ${thrLap} (the reference ${thrRef})` : "";
      return {
        what: `You pick up the throttle later than the reference${cmp}, and leave ${corner.name} at ${n0(lap.exitSpeed)} km/h against ${n0(ref.exitSpeed)}.`,
        fix: thrRef ? `Get back on the throttle ${thrRef}.` : "Get back on the throttle earlier, as soon as the car is pointing at the exit.",
        cue: apexKerb.length ? "landmark" : "feel", evidence: pack("throttle"), cause,
      };
    }
    case "steering":
      return {
        what: `You make ${steerDiff} more steering corrections through ${corner.name} than the reference${speedClause}.`,
        fix: "Turn in once and hold one steady steering input to the apex, without correcting.",
        cue: "feel", evidence: pack("steering"), cause,
      };
    default:
      return {
        what: `${minor ? "Small loss" : "You lose time"} through ${corner.name}: minimum speed ${speeds}${exitClause}.`,
        fix: minor ? "Tidy up the entry and keep the car settled to the apex." : "Carry a little more speed to the apex and stay smooth on the way in.",
        cue: "feel", evidence: pack("speed"), cause,
      };
  }
}

export interface SpreadStats {
  sd: number;
  min: number;
  max: number;
  n: number;
}

/** Sample standard deviation, min and max of the corner times. */
export function spread(times: number[]): SpreadStats {
  const n = times.length;
  const mean = times.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(times.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : 0;
  return { sd, min: Math.min(...times), max: Math.max(...times), n };
}

export function narrateInconsistent(corner: Corner, st: SpreadStats, anchors: Landmark[]): Narrative {
  const board = anchors.find((a) => a.kind === "brake_board");
  return {
    what: `Your time through ${corner.name} varies by ${st.sd.toFixed(3)} s from lap to lap, from ${st.min.toFixed(3)} to ${st.max.toFixed(3)} s.`,
    fix: board
      ? `Use the ${board.label} as your braking reference here and repeat it every lap.`
      : "Pick one braking reference and one turn-in reference here and repeat them every lap.",
    cue: board ? "landmark" : "feel",
    evidence: [`sd ${st.sd.toFixed(3)} s over ${st.n} laps`, `corner time ${st.min.toFixed(3)} to ${st.max.toFixed(3)} s`],
    cause: "brake",
  };
}
