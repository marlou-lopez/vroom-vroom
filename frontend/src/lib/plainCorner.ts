// Plain-language corner summaries for the experimental Simple view (spike vroom-pnw.50). Pure: computed from the
// comparison's per-corner metrics, no coach call. Every number in a sentence comes from those metrics, and the tips
// never use metre distances (the coach rule in CLAUDE.md).
import { effectiveValid, type CompareCandidate, type CornerMetrics, type LapWithRef } from "../api/types";
import { causeOf } from "./cornerCause";
import { MIN_DELTA_S } from "./cornerRail";

export interface PlainCorner {
  corner_id: string;
  /** Seconds lost (positive) or gained (negative) against the comparison. */
  deltaS: number;
  /** What happened, in one sentence, e.g. "You were 6 km/h slower at the slowest point (118 against 124 km/h)." */
  what: string;
  /** What to try next time, in one sentence. Null for a gain or an even corner. */
  tip: string | null;
}

const kmh = (x: number) => Math.round(x);

/**
 * One corner in plain words. `refName` names the comparison in a sentence ("your best lap", "the ideal lap").
 * For a gain the sentence says what went better; for a loss what went worse and a tip.
 */
export function plainCorner(m: CornerMetrics, refName: string): PlainCorner {
  const { lap, ref } = m;
  const base = { corner_id: m.corner_id, deltaS: m.delta_s };
  if (Math.abs(m.delta_s) < MIN_DELTA_S) return { ...base, what: `Same time as ${refName}.`, tip: null };
  const gain = m.delta_s < 0;
  const cause = causeOf(gain ? { ...m, lap: m.ref, ref: m.lap } : m);
  const dv = kmh(lap.min_speed_kmh) - kmh(ref.min_speed_kmh);
  if (gain) {
    switch (cause) {
      case "brake":
        return { ...base, what: lap.brake_onset_m !== null && ref.brake_onset_m !== null && lap.brake_onset_m > ref.brake_onset_m ? `You braked later than on ${refName}.` : `You braked earlier and got a better exit than on ${refName}.`, tip: null };
      case "throttle":
        return { ...base, what: `You got back on the throttle sooner than on ${refName}.`, tip: null };
      case "steering":
        return { ...base, what: `You were smoother on the steering than on ${refName}.`, tip: null };
      case "speed":
        return { ...base, what: dv > 0 ? `You carried ${dv} km/h more through the slowest point.` : `You were quicker through here than on ${refName}.`, tip: null };
    }
  }
  switch (cause) {
    case "brake":
      if (lap.brake_onset_m !== null && ref.brake_onset_m !== null && lap.brake_onset_m < ref.brake_onset_m)
        return { ...base, what: `You started braking earlier than on ${refName}.`, tip: `Brake a little later, at the same point as on ${refName}.` };
      return { ...base, what: `You braked later than on ${refName} and lost speed on the way out.`, tip: "Brake a touch earlier so the car is settled and you can get back on the throttle sooner." };
    case "throttle":
      return { ...base, what: `You got back on the throttle later than on ${refName}.`, tip: "Get the car turned, then squeeze the throttle on as early as you can." };
    case "steering": {
      const n = lap.steer_corrections - ref.steer_corrections;
      return { ...base, what: `You corrected the steering ${n} more ${n === 1 ? "time" : "times"} than on ${refName}.`, tip: "Turn in once and hold a steady wheel; every correction scrubs speed." };
    }
    case "speed":
      if (dv < 0)
        return { ...base, what: `You were ${-dv} km/h slower at the slowest point (${kmh(lap.min_speed_kmh)} against ${kmh(ref.min_speed_kmh)} km/h).`, tip: "Release the brake a little earlier and let the car roll more speed into the middle of the corner." };
      return { ...base, what: `You lost time here against ${refName}, with no single clear cause.`, tip: "Watch this corner against your best lap and copy its line and pedals." };
  }
}

/** Below this a corner reads "0.00 s" at two decimals, so the Simple view neither ranks nor praises it. */
export const PLAIN_MIN_S = 0.005;

/** The corners where the lap lost the most time, worst first. */
export function biggestLosses(corners: CornerMetrics[], n = 3): CornerMetrics[] {
  return corners.filter((c) => c.delta_s >= PLAIN_MIN_S).sort((a, b) => b.delta_s - a.delta_s).slice(0, n);
}

/** The corners where the lap gained the most time, best first. */
export function biggestGains(corners: CornerMetrics[], n = 2): CornerMetrics[] {
  return corners.filter((c) => c.delta_s <= -PLAIN_MIN_S).sort((a, b) => a.delta_s - b.delta_s).slice(0, n);
}

/** "0.20 s" with two decimals: a novice reads tenths and hundredths, not thousandths. */
export function plainSeconds(s: number): string {
  return `${Math.abs(s).toFixed(2)} s`;
}

/** "0.04 s slower than your best lap", "0.12 s faster than the ideal lap", or "the same time as …". */
export function plainGap(gapS: number | null, refName: string): string | null {
  if (gapS === null) return null;
  if (Math.abs(gapS) < 0.005) return `the same time as ${refName}`;
  return `${plainSeconds(gapS)} ${gapS > 0 ? "slower" : "faster"} than ${refName}`;
}

/** How the comparison is named in a sentence: "your best lap (lap 2)", "the ideal lap", "lap 7". */
export function plainRefName(refCand: CompareCandidate | null, laps: LapWithRef[]): string {
  if (!refCand) return "the comparison lap";
  if (refCand.is_ideal) return "your ideal lap";
  const own = laps.find((l) => l.lap_id === refCand.lap_id);
  if (!own) return refCand.label;
  const fastest = fastestValidLap(laps);
  if (fastest?.lap_id === own.lap_id) return `your best lap (lap ${own.lap_no})`;
  return `lap ${own.lap_no}`;
}

/** The fastest valid timed lap of the session, or null: what "your best lap" means in the Simple view. */
export function fastestValidLap(laps: LapWithRef[]): LapWithRef | null {
  return laps.filter((l) => effectiveValid(l) && l.lap_time_s).sort((a, b) => a.lap_time_s! - b.lap_time_s!)[0] ?? null;
}
