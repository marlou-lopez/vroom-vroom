import type { SessionMeta } from "../api/types";

export interface Combo {
  key: string;
  label: string;
  count: number;
}

export const comboKey = (s: Pick<SessionMeta, "track_id" | "car_id">) => `${s.track_id}|${s.car_id}`;

/** Sessions grouped by track and car; the combo with the newest session comes first. */
export function groupCombos(sessions: SessionMeta[]): Combo[] {
  const groups = new Map<string, { label: string; count: number; newest: string }>();
  for (const s of sessions) {
    const key = comboKey(s);
    const g = groups.get(key);
    if (g) {
      g.count += 1;
      if (s.started_at > g.newest) g.newest = s.started_at;
    } else {
      groups.set(key, { label: `${s.track_name} · ${s.car_name}`, count: 1, newest: s.started_at });
    }
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].newest.localeCompare(a[1].newest))
    .map(([key, g]) => ({ key, label: g.label, count: g.count }));
}

export type FocusTone = "good" | "bad" | "unclear";

/** Outcome of last session's focus: `improved` true/false/null. */
export function focusOutcome(improved: boolean | null): { glyph: string; tone: FocusTone; label: string } {
  if (improved === true) return { glyph: "▲", tone: "good", label: "improved" };
  if (improved === false) return { glyph: "▼", tone: "bad", label: "worse" };
  return { glyph: "●", tone: "unclear", label: "unclear" };
}

export interface TrendPoint {
  best: number | null;
  theo: number | null;
}

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Paths (viewBox `w`×`h`) of best and theoretical lap per session, oldest to newest, evenly spaced.
 * Faster laps are drawn higher. `lo`/`hi` are the seconds at the bottom/top edges of the data (before padding).
 */
export function trendPaths(points: TrendPoint[], w: number, h: number, pad = 12): { best: string; theo: string; lo: number; hi: number } {
  const vals = points.flatMap((p) => [p.best, p.theo]).filter((v): v is number => v !== null);
  if (vals.length === 0) return { best: "", theo: "", lo: 0, hi: 0 };
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const n = points.length;
  const build = (pick: (p: TrendPoint) => number | null) => {
    const pts: string[] = [];
    points.forEach((p, i) => {
      const v = pick(p);
      if (v === null) return;
      const x = n === 1 ? w / 2 : (i / (n - 1)) * w;
      const y = pad + ((v - lo) / span) * (h - 2 * pad);
      pts.push(`${r1(x)} ${r1(y)}`);
    });
    if (pts.length === 1) {
      const [x, y] = pts[0].split(" ").map(Number);
      return `M${r1(Math.max(0, x - 20))} ${y}L${r1(Math.min(w, x + 20))} ${y}`;
    }
    return pts.map((p, i) => `${i ? "L" : "M"}${p}`).join("");
  };
  return { best: build((p) => p.best), theo: build((p) => p.theo), lo, hi };
}

export interface HeadlineRow {
  type: string;
  startedAt: string;
  best: number | null;
  theo: number | null;
}

export interface Headline {
  /** Seconds, best − first best (negative = faster). Null without two comparable sessions. */
  change: number | null;
  /** Session type both ends of `change` come from. */
  changeType: string | null;
  changeFrom: HeadlineRow | null;
  changeTo: HeadlineRow | null;
  /** Best − theoretical of the newest session that has both, and the session it comes from. */
  gap: number | null;
  gapFrom: HeadlineRow | null;
}

/**
 * Headline numbers over rows oldest first. A change in best lap is only taken between sessions of one type (a race best
 * against a practice best says nothing about pace): the type of the newest session with a best lap that has a second session of that type, else the newest type.
 * The gap to theoretical comes from the newest session that has both values, so a race without a theoretical lap doesn't blank it.
 */
export function headline(rows: HeadlineRow[]): Headline {
  const withBest = rows.filter((r) => r.best !== null);
  // The newest type with two sessions to compare, else the newest type (so the card can say what it needs).
  const counts = new Map<string, number>();
  for (const r of withBest) counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  const type = [...withBest].reverse().find((r) => (counts.get(r.type) ?? 0) >= 2)?.type ?? (withBest.length ? withBest[withBest.length - 1].type : null);
  const same = withBest.filter((r) => r.type === type);
  const changeFrom = same.length >= 2 ? same[0] : null;
  const changeTo = same.length >= 2 ? same[same.length - 1] : null;
  const change = changeFrom && changeTo ? (changeTo.best as number) - (changeFrom.best as number) : null;
  const gapFrom = [...rows].reverse().find((r) => r.best !== null && r.theo !== null) ?? null;
  const gap = gapFrom ? (gapFrom.best as number) - (gapFrom.theo as number) : null;
  return { change, changeType: type, changeFrom, changeTo, gap, gapFrom };
}
