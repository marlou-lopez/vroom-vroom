import type { CompareResponse, Corner, CornerMetrics } from "../api/types";
import { causeOf, type Cause } from "./cornerCause";

/** Corners whose delta rounds to nothing are neither a gain nor a loss. */
export const MIN_DELTA_S = 0.001;

export interface CornerRailRow {
  corner: Corner;
  /** Lap minus reference over the corner: positive = lost. */
  deltaS: number;
  kind: "loss" | "gain" | "even";
  /** Why, as a direction ("lower min speed", "later throttle"); null for an even corner. */
  direction: string | null;
}

/**
 * The cause as a direction in terms of this lap against the comparison. For a loss it says what the lap did worse; for
 * a gain (scored with the laps swapped, as the coach does) what it did better.
 */
export function causeDirection(m: CornerMetrics): string | null {
  if (Math.abs(m.delta_s) < MIN_DELTA_S) return null;
  const gain = m.delta_s < 0;
  const cause: Cause = causeOf(gain ? { ...m, lap: m.ref, ref: m.lap } : m);
  const { lap, ref } = m;
  switch (cause) {
    case "speed":
      // `causeOf` falls back to speed when nothing stands out: then only a direction that explains the delta is shown.
      if (gain) return lap.min_speed_kmh > ref.min_speed_kmh ? "higher min speed" : null;
      return lap.min_speed_kmh < ref.min_speed_kmh ? "lower min speed" : null;
    case "brake":
      if (lap.brake_onset_m === null || ref.brake_onset_m === null) return "braking";
      return lap.brake_onset_m < ref.brake_onset_m ? "earlier braking" : "later braking";
    case "throttle":
      if (lap.throttle_pickup_m === null || ref.throttle_pickup_m === null) return "throttle";
      return lap.throttle_pickup_m > ref.throttle_pickup_m ? "later throttle" : "earlier throttle";
    case "steering":
      return lap.steer_corrections >= ref.steer_corrections ? "more steering corrections" : "fewer steering corrections";
  }
}

/** Every corner the map knows, in track order, from the comparison's per-corner metrics (no coach call). Empty when the lap is its own reference. */
export function cornerRailRows(cmp: CompareResponse, corners: Corner[]): CornerRailRow[] {
  if (cmp.lap_id === cmp.ref_lap_id) return [];
  const byId = new Map(corners.map((c) => [c.id, c]));
  const rows: CornerRailRow[] = [];
  for (const m of cmp.corners) {
    const corner = byId.get(m.corner_id);
    if (!corner) continue;
    const kind = m.delta_s >= MIN_DELTA_S ? "loss" : m.delta_s <= -MIN_DELTA_S ? "gain" : "even";
    rows.push({ corner, deltaS: m.delta_s, kind, direction: causeDirection(m) });
  }
  return rows.sort((a, b) => a.corner.start_m - b.corner.start_m);
}
