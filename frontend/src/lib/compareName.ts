import type { CompareCandidate, LapWithRef } from "../api/types";

/**
 * A short name for the comparison lap, for places that say who you are ahead of or behind: "ideal", "reference",
 * "L7" (a lap of the studied session) or the candidate's full label (a lap of another session). Null while unknown.
 */
export function comparisonName(refCand: CompareCandidate | null, laps: Pick<LapWithRef, "lap_id" | "lap_no">[]): string | null {
  if (!refCand) return null;
  if (refCand.is_ideal) return "ideal";
  if (refCand.is_reference) return "reference";
  const own = laps.find((l) => l.lap_id === refCand.lap_id);
  return own ? `L${own.lap_no}` : refCand.label;
}

/** "behind ideal" or "ahead of L7": where you stand against the comparison, from the delta (positive = you are slower). Null when level or unnamed. */
export function standingLabel(delta: number, name: string | null): string | null {
  if (!name || Math.abs(delta) <= 0.005) return null;
  return delta > 0 ? `behind ${name}` : `ahead of ${name}`;
}
