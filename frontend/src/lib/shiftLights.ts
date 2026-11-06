/**
 * Shift lights and the rev limit, derived from a lap's own data (#101): no per-car table. Pure and unit-tested.
 *
 * The limit is a high percentile of the rpm just before each upshift on the lap (what the driver actually shifts at, which on a
 * flat-out lap is at or near the limiter). A lap with fewer than `MIN_UPSHIFTS` upshifts falls back to the highest rpm seen.
 */

export interface RpmLimits {
  /** The rpm where the lights are all on and flash. */
  limit: number;
  /** The rpm where the first light comes on. */
  start: number;
}

/** Gears: -1 reverse, 0 neutral, 1.. forward. */
export const MIN_UPSHIFTS = 3;
/** The percentile of the pre-upshift rpm taken as the limit. */
export const LIMIT_PERCENTILE = 0.9;
/** Metres before a gear change searched for the peak rpm (the grid is one value per metre; a shift takes a few). */
export const PRE_SHIFT_WINDOW = 3;
/** The first light comes on at this share of the limit. */
export const START_FRACTION = 0.8;
/** The lights flash from this share of the limit. */
export const FLASH_FRACTION = 0.985;
/** Lights in a row (the shared design and the model's RPM_LED_0..9). */
export const LED_COUNT = 10;

/** `p` (0..1) quantile of a sorted copy of `v`, linear between neighbours. */
export function quantile(v: readonly number[], p: number): number {
  if (v.length === 0) return NaN;
  const s = [...v].sort((a, b) => a - b);
  const x = Math.min(Math.max(p, 0), 1) * (s.length - 1);
  const i = Math.floor(x);
  return i + 1 < s.length ? s[i] + (s[i + 1] - s[i]) * (x - i) : s[i];
}

/** The rpm at each upshift: the highest value in the `PRE_SHIFT_WINDOW` samples before a forward gear goes up. */
export function preUpshiftRpm(rpm: ArrayLike<number>, gear: ArrayLike<number>): number[] {
  const out: number[] = [];
  const n = Math.min(rpm.length, gear.length);
  for (let i = 1; i < n; i++) {
    if (gear[i] > gear[i - 1] && gear[i - 1] >= 1) {
      let peak = -Infinity;
      for (let k = Math.max(i - PRE_SHIFT_WINDOW, 0); k < i; k++) if (Number.isFinite(rpm[k])) peak = Math.max(peak, rpm[k]);
      if (peak > 0) out.push(peak);
    }
  }
  return out;
}

/** The limit and first-light rpm for a lap, or null when the lap has no usable rpm. */
export function deriveRpmLimits(rpm: ArrayLike<number>, gear: ArrayLike<number>): RpmLimits | null {
  const up = preUpshiftRpm(rpm, gear);
  let limit: number;
  if (up.length >= MIN_UPSHIFTS) limit = quantile(up, LIMIT_PERCENTILE);
  else {
    limit = 0;
    for (let i = 0; i < rpm.length; i++) if (Number.isFinite(rpm[i])) limit = Math.max(limit, rpm[i]);
  }
  if (!(limit > 0)) return null;
  return { limit, start: limit * START_FRACTION };
}

export type LedColour = "green" | "yellow" | "red";

/** Colour of light `i` of `n`: the first 40 % green, the next 40 % yellow, the last 20 % red. */
export function ledColour(i: number, n = LED_COUNT): LedColour {
  const f = (i + 1) / n;
  return f <= 0.4 ? "green" : f <= 0.8 ? "yellow" : "red";
}

export interface ShiftLights {
  /** How many lights are on, counted from the first. */
  lit: number;
  /** At the limit: all lights blink together (see `flashOn`). */
  flashing: boolean;
  /** The blink's phase: when `flashing`, lights show only while this is true. */
  flashOn: boolean;
}

/** Blinks per second at the limit. */
export const FLASH_HZ = 6;

/**
 * Which lights are on at `rpm`. They fill evenly from `limits.start` to `limits.limit`; from `FLASH_FRACTION` of the limit they
 * blink, driven by `clockS` (seconds, e.g. the playback time) so the blink follows playback and scrubbing.
 */
export function shiftLights(rpm: number, limits: RpmLimits | null, clockS: number, n = LED_COUNT): ShiftLights {
  if (!limits || !(rpm > limits.start)) return { lit: 0, flashing: false, flashOn: true };
  const share = Math.min((rpm - limits.start) / (limits.limit - limits.start), 1);
  const lit = Math.min(Math.ceil(share * n), n);
  const flashing = rpm >= limits.limit * FLASH_FRACTION;
  return { lit, flashing, flashOn: !flashing || Math.floor(clockS * FLASH_HZ * 2) % 2 === 0 };
}
