import type { ChannelArrays } from "../../../api/types";

/** What the cockpit dash shows at one instant (#101): the lap car's channels at its current distance. */
export interface DashValues {
  /** -1..1, + = right. */
  steering: number;
  /** The wheel's total lock-to-lock range in degrees, or null for an unknown car (a nominal range is used). */
  steeringRangeDeg: number | null;
  /** -1 reverse, 0 neutral, 1.. */
  gear: number;
  rpm: number;
  speedKmh: number;
  /** 0..1 */
  throttle: number;
  brake: number;
  /** Seconds the lap is behind the reference lap at this point (negative = ahead), or null when unknown. */
  deltaS: number | null;
  /** Seconds, for the shift lights' blink (playback time). */
  clockS: number;
}

/** Wheel lock-to-lock range used when the car's is unknown (degrees): the wheel turns +/- half of it at full lock. */
export const NOMINAL_STEERING_RANGE_DEG = 360;

/** The wheel's angle in degrees for a normalised steering value: positive = turned right (clockwise). */
export function wheelAngleDeg(steering: number, rangeDeg: number | null): number {
  return (steering * (rangeDeg ?? NOMINAL_STEERING_RANGE_DEG)) / 2;
}

const lerpAt = (a: ArrayLike<number>, d: number): number => {
  const last = a.length - 1;
  if (last < 0) return 0;
  const x = Math.min(Math.max(d, 0), last);
  const i = Math.floor(x);
  return i >= last ? a[last] : a[i] + (a[i + 1] - a[i]) * (x - i);
};

/** The lap's dash values at fractional grid distance `d` (one value per metre; gear is not interpolated). */
export function dashAt(lap: Pick<ChannelArrays, "steering" | "gear" | "rpm" | "speed_kmh" | "throttle" | "brake">, d: number, steeringRangeDeg: number | null, clockS: number, delta?: ArrayLike<number>): DashValues {
  const last = lap.gear.length - 1;
  const gear = last < 0 ? 0 : lap.gear[Math.min(Math.max(Math.round(d), 0), last)];
  return {
    steering: lerpAt(lap.steering, d), steeringRangeDeg, gear, rpm: lerpAt(lap.rpm, d), speedKmh: lerpAt(lap.speed_kmh, d),
    throttle: lerpAt(lap.throttle, d), brake: lerpAt(lap.brake, d),
    deltaS: delta && delta.length > 0 ? lerpAt(delta, d) : null, clockS,
  };
}
