import type { ChannelArrays } from "../api/types";

// Driver aids and tyre slip (vroom-pnw.14): where ABS and TC were working, and where a wheel locked or spun.
// LMU has no slip channel; the grid's slip_* are wheel surface speed / ground speed (tools/extract-laps.mjs).

/** Below this ground speed (m/s) the slip ratio is meaningless (parked, pit lane) and reads 1. */
export const MIN_SLIP_SPEED_MS = 5;
/** First guesses (the issue's); tune them with real lockups and wheelspin (#25). */
export const LOCKUP_SLIP = 0.9;
export const WHEELSPIN_SLIP = 1.1;
/** A wheel only counts as locked / spinning with at least this much pedal. */
export const MIN_PEDAL = 0.05;
/** Marks closer than this many metres merge into one run, so a flickering ratio is one mark. */
export const MERGE_GAP_M = 2;

/** Slip ratio of one wheel: its surface speed over the ground speed (both m/s); 1 (no slip) when the car is slower than MIN_SLIP_SPEED_MS. */
export function slipRatio(wheelMs: number, groundMs: number): number {
  return groundMs < MIN_SLIP_SPEED_MS ? 1 : wheelMs / groundMs;
}

/**
 * The driven wheels, for wheelspin. Every GT3 car in LMU is rear-wheel drive; hypercars with a front motor
 * (only above ~190 km/h) are not modelled, so a front wheel spinning there is not flagged.
 */
export const DRIVEN_SLIP = ["slip_rl", "slip_rr"] as const;
const ALL_SLIP = ["slip_fl", "slip_fr", "slip_rl", "slip_rr"] as const;

export type AidChannels = Pick<ChannelArrays, "abs" | "tc" | "brake" | "throttle" | "slip_fl" | "slip_fr" | "slip_rl" | "slip_rr">;

/** A stretch of the lap as inclusive grid indices (the grid index is the distance in metres). */
export interface Run { start: number; end: number }

export interface AidRuns { abs: Run[]; tc: Run[]; lockup: Run[]; wheelspin: Run[] }

/** Runs of consecutive truthy values; gaps of at most `mergeGap` falsy values between two runs are bridged. */
export function runsOf(flag: (i: number) => boolean, n: number, mergeGap = 0): Run[] {
  const runs: Run[] = [];
  for (let i = 0; i < n; i++) {
    if (!flag(i)) continue;
    const last = runs[runs.length - 1];
    if (last && i - last.end - 1 <= mergeGap) last.end = i;
    else runs.push({ start: i, end: i });
  }
  return runs;
}

/** Whether any wheel in `keys` is outside the limit at metre i: below `LOCKUP_SLIP` or above `WHEELSPIN_SLIP`. */
const slipBeyond = (ch: AidChannels, keys: readonly (typeof ALL_SLIP)[number][], i: number, lock: boolean) =>
  keys.some((k) => (lock ? ch[k][i] < LOCKUP_SLIP : ch[k][i] > WHEELSPIN_SLIP));

/** Where each aid was active, and where a wheel was locked (braking, any wheel) or spinning (on throttle, a driven wheel). */
export function aidRuns(ch: AidChannels): AidRuns {
  const n = ch.brake.length;
  return {
    abs: runsOf((i) => ch.abs[i] > 0, n),
    tc: runsOf((i) => ch.tc[i] > 0, n),
    lockup: runsOf((i) => ch.brake[i] > MIN_PEDAL && slipBeyond(ch, ALL_SLIP, i, true), n, MERGE_GAP_M),
    wheelspin: runsOf((i) => ch.throttle[i] > MIN_PEDAL && slipBeyond(ch, DRIVEN_SLIP, i, false), n, MERGE_GAP_M),
  };
}

/** A run widened by one metre at its end, so a single-metre run still has a visible length on the map. */
export const mapSpan = (r: Run, lastIndex: number): [number, number] => [r.start, Math.min(r.end + 1, lastIndex)];
