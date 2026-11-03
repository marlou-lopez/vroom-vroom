// Pure playback helpers: time/index lookup, steering units, scrubber path.

/** Last index with `t[i] <= tau` (binary search), clamped to 0..t.length-1. */
export function indexAtTime(t: ArrayLike<number>, tau: number): number {
  const n = t.length;
  if (n === 0 || !(tau > t[0])) return 0;
  if (tau >= t[n - 1]) return n - 1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t[mid] <= tau) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Fractional grid position (in metres on the 1 m grid) of time `tau`, interpolated between samples. */
export function distanceAtTime(t: ArrayLike<number>, distance: ArrayLike<number>, tau: number): number {
  const i = indexAtTime(t, tau);
  if (i >= t.length - 1) return distance[i] ?? 0;
  const span = t[i + 1] - t[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (tau - t[i]) / span)) : 0;
  return distance[i] + f * (distance[i + 1] - distance[i]);
}

/** Time at which the lap reaches distance `d` (clamped). `distance` must be ascending. */
export function timeAtDistance(t: ArrayLike<number>, distance: ArrayLike<number>, d: number): number {
  if (t.length === 0) return 0;
  const i = indexAtTime(distance, d);
  if (i >= t.length - 1) return t[t.length - 1];
  const span = distance[i + 1] - distance[i];
  const f = span > 0 ? Math.min(1, Math.max(0, (d - distance[i]) / span)) : 0;
  return t[i] + f * (t[i + 1] - t[i]);
}

export type SteeringDisplay = { value: number; unit: "deg" | "%" };

/** Degrees = norm × range / 2. Without a known range, show the normalised value as a percentage. */
export function steeringDisplay(norm: number, rangeDeg: number | null): SteeringDisplay {
  return rangeDeg === null ? { value: norm * 100, unit: "%" } : { value: (norm * rangeDeg) / 2, unit: "deg" };
}

/** Wheel rotation in degrees for the simplified view; in `%` mode it is norm × 135 so the wheel still turns. */
export function wheelRotation(norm: number, rangeDeg: number | null): number {
  const d = steeringDisplay(norm, rangeDeg);
  return d.unit === "deg" ? d.value : norm * 135;
}

export function formatSteering(norm: number, rangeDeg: number | null): string {
  const d = steeringDisplay(norm, rangeDeg);
  return `${Math.round(d.value)}${d.unit === "deg" ? "°" : "%"}`;
}

/** Advance the playhead; wraps to 0 at the end of the lap. */
export function advanceTau(tau: number, dt: number, rate: number, duration: number): number {
  const next = tau + dt * rate;
  return next >= duration ? 0 : next;
}

const f1 = (v: number) => (Math.round(v * 10) / 10).toString();

/** Whole-lap delta line for the scrubber: x = time fraction of the lap, y centred with ±`absMax` filling the height. */
export function scrubberPath(t: ArrayLike<number>, delta: ArrayLike<number>, w = 1000, h = 34, pad = 3): string {
  const n = Math.min(t.length, delta.length);
  if (n === 0) return "";
  const total = t[n - 1] || 1;
  let absMax = 0.05;
  for (let i = 0; i < n; i++) absMax = Math.max(absMax, Math.abs(delta[i]));
  const mid = h / 2;
  const k = (h / 2 - pad) / absMax;
  const parts: string[] = [];
  const step = Math.max(1, Math.floor(n / 1500));
  for (let i = 0; i < n; i += step) {
    parts.push(`${parts.length ? "L" : "M"}${f1((t[i] / total) * w)} ${f1(mid - delta[i] * k)}`);
  }
  return parts.join("");
}
