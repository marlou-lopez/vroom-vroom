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
