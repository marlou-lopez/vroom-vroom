import type { CoachResults, CompareResponse, Finding, FindingKind, TrackMap } from "../api/types";
import { annotationColors } from "../theme";
import { timeAtDistance } from "./playback";

/** Play-from-here and badge clicks seek this far before the corner starts. */
export const CORNER_LEAD_M = 150;

export interface Annotation {
  findingId: string;
  cornerId: string;
  kind: FindingKind;
  /** "1".."3" for issues, "!" minor, "✓" strength or reviewed, "~" inconsistent. */
  label: string;
  color: string;
  startM: number;
  apexM: number;
  endM: number;
  /** The lap's own time at those distances. */
  tStart: number;
  tApex: number;
  tEnd: number;
  reviewed: boolean;
  finding: Finding;
  /** 0 for the first finding on a corner, 1.. for later ones (badges and chips are offset by this). */
  stack: number;
}

const FIXED_LABEL: Record<Exclude<FindingKind, "issue">, string> = { minor: "!", strength: "✓", inconsistent: "~" };

/** Annotations from the analyze and average results together (the corner deep-dive is shown in the popup instead). */
export function toAnnotations(results: CoachResults, cmp: CompareResponse, map: TrackMap): Annotation[] {
  const findings = [...(results.analyze?.findings ?? []), ...(results.average?.findings ?? [])];
  // Issue numbers follow descending time_s (stable for ties).
  const issueRank = new Map<string, number>();
  findings
    .filter((f) => f.kind === "issue")
    .sort((a, b) => b.time_s - a.time_s)
    .forEach((f, i) => issueRank.set(f.id, i + 1));

  const out: Annotation[] = [];
  for (const f of findings) {
    const c = map.corners.find((k) => k.id === f.corner_id);
    if (!c) continue;
    const label = f.reviewed ? "✓" : f.kind === "issue" ? String(issueRank.get(f.id)) : FIXED_LABEL[f.kind];
    out.push({
      findingId: f.id, cornerId: c.id, kind: f.kind, label,
      color: f.reviewed ? annotationColors.reviewed : annotationColors[f.kind],
      startM: c.start_m, apexM: c.apex_m, endM: c.end_m,
      tStart: timeAtDistance(cmp.lap.t, cmp.distance, c.start_m),
      tApex: timeAtDistance(cmp.lap.t, cmp.distance, c.apex_m),
      tEnd: timeAtDistance(cmp.lap.t, cmp.distance, c.end_m),
      reviewed: f.reviewed, finding: f, stack: 0,
    });
  }
  stackIndices(out.map((a) => a.cornerId)).forEach((n, i) => (out[i].stack = n));
  return out;
}

/** For each key, how many earlier entries share it: [a, b, a, a] gives [0, 0, 1, 2]. */
export function stackIndices(keys: string[]): number[] {
  const seen = new Map<string, number>();
  return keys.map((k) => {
    const n = seen.get(k) ?? 0;
    seen.set(k, n + 1);
    return n;
  });
}

/** Where "Play from here" and badge clicks seek to (lap time). */
export function leadInTime(cmp: CompareResponse, a: Pick<Annotation, "startM">): number {
  return timeAtDistance(cmp.lap.t, cmp.distance, a.startM - CORNER_LEAD_M);
}
