import type { IdealLap, SegmentTimes } from "../api/types";

/** How a lap did in one segment, in timing-screen terms: `purple` holds the ideal segment, the rest by time lost against it. */
export type CellTone = "purple" | "green" | "yellow" | "red";

/** Time lost (s) up to which a segment is still "close" (green), and up to which it is "slow" (yellow); beyond is red. */
export const CLOSE_S = 0.1;
export const SLOW_S = 0.3;
/** Times are rounded to the millisecond, so a loss below this is a tie. */
const TIE_S = 0.0005;

export interface SegmentCell {
  label: string;
  start_m: number;
  end_m: number;
  /** The lap's time in the segment, and its time lost against the ideal's (0 when it holds it). */
  time_s: number;
  loss_s: number;
  tone: CellTone;
}

export interface LapGauge {
  lapId: string;
  lapNo: number;
  lapTimeS: number;
  /** Lap time minus the ideal lap's; never negative for a valid lap of the session. */
  gapToIdealS: number;
  /** Lap time minus the best valid lap's (0 for the best lap). */
  gapToBestS: number;
  cells: SegmentCell[];
}

/** The shade of one segment: purple when the lap holds the ideal time, otherwise by time lost. */
export function cellTone(lossS: number, holds: boolean): CellTone {
  if (holds || lossS <= TIE_S) return "purple";
  if (lossS <= CLOSE_S) return "green";
  if (lossS <= SLOW_S) return "yellow";
  return "red";
}

export function segmentCells(lapId: string, segmentS: number[], ideal: IdealLap): SegmentCell[] {
  return ideal.segments.map((seg, k) => {
    const time = segmentS[k] ?? seg.best_s;
    const holds = seg.lap_id === lapId;
    const loss = holds ? 0 : Math.max(0, time - seg.best_s);
    return { label: seg.label, start_m: seg.start_m, end_m: seg.end_m, time_s: time, loss_s: loss, tone: cellTone(loss, holds) };
  });
}

/**
 * Gap to the ideal and to the best lap, and the segment strip, for every valid flying lap of a session.
 * `lapTimes` maps lap id to the lap's time; a lap with no entry in `times` (invalid, out lap) gets no gauge.
 */
export function lapGauges(ideal: IdealLap, times: SegmentTimes, lapTimes: ReadonlyMap<string, number>): Map<string, LapGauge> {
  const out = new Map<string, LapGauge>();
  const valid = times.laps.filter((l) => (lapTimes.get(l.lap_id) ?? 0) > 0);
  const best = valid.length ? Math.min(...valid.map((l) => lapTimes.get(l.lap_id)!)) : 0;
  for (const l of valid) {
    const t = lapTimes.get(l.lap_id)!;
    out.set(l.lap_id, {
      lapId: l.lap_id, lapNo: l.lap_no, lapTimeS: t,
      gapToIdealS: Math.max(0, t - ideal.time_s), gapToBestS: Math.max(0, t - best),
      cells: segmentCells(l.lap_id, l.segment_s, ideal),
    });
  }
  return out;
}

/** `+0.412`, or `—` for no gauge. */
export function formatGap(s: number | null | undefined): string {
  return s === null || s === undefined ? "—" : `+${s.toFixed(3)}`;
}

/** The URL of a lap opened at a distance on the Telemetry page. */
export function lapAtHref(lapId: string, startM: number): string {
  return `/?lap=${encodeURIComponent(lapId)}&at=${Math.round(startM)}`;
}
