import type { Landmark } from "../api/types";

/** "at", "just after", "a little before", "well after": a qualitative offset, never a distance. */
export function offsetPhrase(d: number): string {
  const a = Math.abs(d);
  if (a <= 8) return "at";
  const dir = d > 0 ? "after" : "before";
  return a <= 25 ? `just ${dir}` : a <= 60 ? `a little ${dir}` : `well ${dir}`;
}

/** "just after the 100 board" against the nearest anchor within `maxM`, or null when no usable landmark is that close. */
export function describeAgainst(pos: number, anchors: Landmark[], maxM = 120): string | null {
  let best: Landmark | null = null;
  for (const a of anchors) if (!best || Math.abs(pos - a.distance_m) < Math.abs(pos - best.distance_m)) best = a;
  if (!best || Math.abs(pos - best.distance_m) > maxM) return null;
  return `${offsetPhrase(pos - best.distance_m)} the ${best.label}`;
}
