import type { CornerMetrics } from "../api/types";

export type Cause = "brake" | "throttle" | "steering" | "speed";

/** The dominant cause of a corner's loss, scored from the same `CornerMetrics` the API serves. */
export function causeOf(m: CornerMetrics): Cause {
  const { lap, ref } = m;
  const score: [Cause, number][] = [
    ["brake", lap.brake_onset_m !== null && ref.brake_onset_m !== null ? Math.abs(lap.brake_onset_m - ref.brake_onset_m) / 15 : 0],
    ["throttle", lap.throttle_pickup_m !== null && ref.throttle_pickup_m !== null ? (lap.throttle_pickup_m - ref.throttle_pickup_m) / 15 : 0],
    ["steering", (lap.steer_corrections - ref.steer_corrections) / 2],
    ["speed", (ref.min_speed_kmh - lap.min_speed_kmh) / 3],
  ];
  let best: [Cause, number] = ["speed", 0];
  for (const s of score) if (s[1] >= 1 && s[1] > best[1]) best = s;
  return best[0];
}
