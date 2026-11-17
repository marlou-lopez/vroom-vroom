import { effectiveValid, type LapMeta } from "../api/types";

/** The fastest valid flying lap that has a trace (so it can be opened), or null. */
export function bestValidLap<T extends LapMeta>(laps: T[]): T | null {
  let best: T | null = null;
  for (const l of laps) {
    if (!l.has_trace || l.kind !== "flying" || !effectiveValid(l) || l.lap_time_s === null) continue;
    if (best === null || l.lap_time_s < (best.lap_time_s as number)) best = l;
  }
  return best;
}

/**
 * The lap the Telemetry page opens with no `?lap`: the newest (highest lap number) valid flying lap with a trace that is
 * not the reference, so it is compared against the reference and not against itself. Falls back to the best valid lap
 * when the reference is the only one.
 */
export function defaultLap<T extends LapMeta & { is_reference: boolean }>(laps: T[]): T | null {
  let newest: T | null = null;
  for (const l of laps) {
    if (l.is_reference || !l.has_trace || l.kind !== "flying" || !effectiveValid(l) || l.lap_time_s === null) continue;
    if (newest === null || l.lap_no > newest.lap_no) newest = l;
  }
  return newest ?? bestValidLap(laps);
}
