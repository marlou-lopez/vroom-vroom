// The Lap view's story column (vroom-pnw.60): the three biggest losses as cards, the "Every corner" rows, and the map
// numbers that follow the cards' ranking. Pure: computed from the comparison and the coach's findings.
import type { Annotation } from "./annotations";
import type { CoachResults, CompareResponse, Corner } from "../api/types";
import { cornerRailRows, type CornerRailRow } from "./cornerRail";
import { plainCorner, PLAIN_MIN_S, type PlainCorner } from "./plainCorner";

export interface StoryCard {
  rank: number;
  row: CornerRailRow;
  /** What happened, in one sentence. */
  what: string;
  /** The advice: the coach's fix once it has run, else the tip worked out from the laps. Never the same text as another card's. */
  advice: { by: "coach" | "computed"; text: string } | null;
}

export interface Story {
  /** Every corner, in track order. */
  rows: CornerRailRow[];
  /** The corners that lost time (at least PLAIN_MIN_S), worst first. */
  losses: CornerRailRow[];
  cards: StoryCard[];
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();

/** The first non-strength fix the coach gave for each corner (Analyze before Average). */
export function coachFixes(results: CoachResults): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of [results.analyze, results.average])
    for (const f of r?.findings ?? []) if (f.kind !== "strength" && f.fix.trim() && !out.has(f.corner_id)) out.set(f.corner_id, f.fix);
  return out;
}

/**
 * The story for one comparison. No two cards show the same advice text: when the coach repeats a fix (or two corners
 * share a computed tip) the later card falls back to its own computed tip, and failing that shows no advice, rather than repeating itself.
 */
export function lapStory(cmp: CompareResponse, corners: Corner[], results: CoachResults, refName: string, n = 3): Story {
  const rows = cornerRailRows(cmp, corners);
  const losses = rows.filter((r) => r.deltaS >= PLAIN_MIN_S).sort((a, b) => b.deltaS - a.deltaS);
  const fixes = coachFixes(results);
  const seen = new Set<string>();
  const cards = losses.slice(0, n).map((row, i): StoryCard => {
    const m = cmp.corners.find((c) => c.corner_id === row.corner.id)!;
    const plain: PlainCorner = plainCorner(m, refName);
    const fix = fixes.get(row.corner.id);
    let advice: StoryCard["advice"] = null;
    if (fix && !seen.has(norm(fix))) advice = { by: "coach", text: fix };
    else if (plain.tip) {
      if (!seen.has(norm(plain.tip))) advice = { by: "computed", text: plain.tip };
    }
    if (advice) seen.add(norm(advice.text));
    return { rank: i + 1, row, what: plain.what, advice };
  });
  return { rows, losses, cards };
}

/**
 * The map's issue numbers follow the story: an unreviewed issue on a losing corner is numbered by that corner's place
 * in the story's ranking (biggest loss first), not by the coach's own time estimate. Other marks are left as they are.
 */
export function relabelByStory(annotations: Annotation[], losses: CornerRailRow[]): Annotation[] {
  if (annotations.length === 0 || losses.length === 0) return annotations;
  const rank = new Map(losses.map((r, i) => [r.corner.id, i + 1]));
  // Issues on corners outside the ranking continue after it (in the coach's own order), so no number appears twice.
  const rest = annotations
    .filter((a) => a.kind === "issue" && !a.reviewed && !rank.has(a.cornerId))
    .sort((a, b) => Number(a.label) - Number(b.label));
  const next = new Map<string, number>();
  for (const a of rest) if (!next.has(a.cornerId)) next.set(a.cornerId, losses.length + 1 + next.size);
  return annotations.map((a) => {
    const r = a.kind === "issue" && !a.reviewed ? (rank.get(a.cornerId) ?? next.get(a.cornerId)) : undefined;
    return r === undefined || String(r) === a.label ? a : { ...a, label: String(r) };
  });
}
