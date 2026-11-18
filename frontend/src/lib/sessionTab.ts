// Pure helpers for the Session tab (vroom-bi4.12): what the session charts draw and how the event list is grouped and filtered.
import { REPORT_CATEGORIES, type Axles, type ReportCategory, type ReportEvent, type ReportLap, type ReportSeverity, type ReportWindow, type SessionReport } from "../api/types";

/** The reference for opening a lap from the tab: the session's best valid flying lap that has a trace (null when there is none). */
export function sessionBestLap(laps: ReportLap[]): ReportLap | null {
  let best: ReportLap | null = null;
  for (const l of laps) {
    if (l.kind !== "flying" || !l.valid || !l.has_trace || l.lap_time_s === null || l.lap_time_s <= 0) continue;
    if (best === null || l.lap_time_s < (best.lap_time_s as number)) best = l;
  }
  return best;
}

/** The first lap of an event's lap range that has a trace, else the first lap of the range that exists. */
export function eventLap(e: Pick<ReportEvent, "lap_from" | "lap_to">, laps: ReportLap[]): ReportLap | null {
  const inRange = laps.filter((l) => l.lap_no >= e.lap_from && l.lap_no <= e.lap_to);
  return inRange.find((l) => l.has_trace) ?? inRange[0] ?? null;
}

export type ChartMetric = "tyre_surface_c" | "tyre_pressure_kpa" | "brake_c";

export const CHARTS: { metric: ChartMetric; title: string; unit: string; pick: (l: ReportLap) => Axles | null }[] = [
  { metric: "tyre_surface_c", title: "Tyre surface temperature", unit: "°C", pick: (l) => l.tyre_surface_c },
  { metric: "tyre_pressure_kpa", title: "Tyre pressure", unit: "kPa", pick: (l) => l.tyre_pressure_kpa },
  { metric: "brake_c", title: "Brake disc temperature", unit: "°C", pick: (l) => l.brake_c },
];

export function windowFor(windows: ReportWindow[], key: string): ReportWindow | null {
  return windows.find((w) => w.key === key) ?? null;
}

/** Y range covering the values and the window, padded by 8 %. null when there is nothing to scale. */
export function yRange(values: number[], win: { min: number; max: number } | null): { lo: number; hi: number } | null {
  const all = [...values, ...(win ? [win.min, win.max] : [])];
  if (values.length === 0 || all.length === 0) return null;
  let lo = Math.min(...all), hi = Math.max(...all);
  if (hi - lo < 1e-9) { lo -= 1; hi += 1; }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

/** Lap-time axis: the flying valid laps, clamped so one slow lap (a lap with a stop) does not flatten the rest. */
export function lapTimeRange(laps: ReportLap[]): { lo: number; hi: number } | null {
  const t = laps.filter((l) => l.kind === "flying" && l.valid && l.lap_time_s !== null && l.lap_time_s > 0).map((l) => l.lap_time_s as number).sort((a, b) => a - b);
  if (t.length === 0) return null;
  const median = t[Math.floor(t.length / 2)];
  const hi = Math.min(t[t.length - 1], median * 1.1);
  return yRange([t[0], hi], null);
}

const SEVERITY_RANK: Record<ReportSeverity, number> = { info: 0, watch: 1, problem: 2 };

/** The worst severity of each lap's events (an event covers its whole lap range), by lap number. */
export function lapSeverity(events: ReportEvent[]): Map<number, ReportSeverity> {
  const out = new Map<number, ReportSeverity>();
  for (const e of events) {
    for (let n = e.lap_from; n <= e.lap_to; n++) {
      const cur = out.get(n);
      if (cur === undefined || SEVERITY_RANK[e.severity] > SEVERITY_RANK[cur]) out.set(n, e.severity);
    }
  }
  return out;
}

/** In-car setting changes (the report's `setting_changed` events), for the markers on the charts. */
export function settingChanges(events: ReportEvent[]): ReportEvent[] {
  return events.filter((e) => e.kind === "setting_changed");
}

export function categoryCounts(events: ReportEvent[]): Record<ReportCategory, number> {
  const out = Object.fromEntries(REPORT_CATEGORIES.map((c) => [c, 0])) as Record<ReportCategory, number>;
  for (const e of events) out[e.category]++;
  return out;
}

export interface EventGroup { key: string; label: string; lapFrom: number; lapTo: number; events: ReportEvent[] }

export function lapRangeLabel(from: number, to: number): string {
  return from === to ? `Lap ${from}` : `Laps ${from}–${to}`;
}

/** Events in report order (by first lap), grouped by identical lap range. An empty `categories` set means all. */
export function groupEvents(events: ReportEvent[], categories: ReadonlySet<ReportCategory>): EventGroup[] {
  const groups: EventGroup[] = [];
  const byKey = new Map<string, EventGroup>();
  for (const e of events) {
    if (categories.size > 0 && !categories.has(e.category)) continue;
    const key = `${e.lap_from}-${e.lap_to}`;
    let g = byKey.get(key);
    if (!g) {
      g = { key, label: lapRangeLabel(e.lap_from, e.lap_to), lapFrom: e.lap_from, lapTo: e.lap_to, events: [] };
      byKey.set(key, g);
      groups.push(g);
    }
    g.events.push(e);
  }
  return groups.sort((a, b) => a.lapFrom - b.lapFrom || a.lapTo - b.lapTo);
}

/** True when no lap of the report can be replayed. */
export const noPlayback = (r: Pick<SessionReport, "laps">): boolean => r.laps.every((l) => !l.has_trace);
