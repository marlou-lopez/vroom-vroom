// A short session summary (vroom-34t, placed by the vroom-pnw.58 overhaul spike): two or three plain sentences built
// from the session report, for the top of the Session view. Pure: every number comes from the report.
import type { ReportEvent, ReportLap, SessionReport } from "../api/types";
import { formatLapTime } from "./format";

const SEVERITY_RANK = { problem: 0, watch: 1, info: 2 } as const;

/** The timed, valid laps with a time: the ones a driver means by "my laps". */
function timedLaps(laps: ReportLap[]): ReportLap[] {
  return laps.filter((l) => l.kind === "flying" && l.valid && l.lap_time_s !== null && l.lap_time_s > 0);
}

/** The event most worth reading first: needs fixing before keep an eye on it; within one, the earliest lap. Never an info event. */
export function headlineEvent(events: ReportEvent[]): ReportEvent | null {
  const ranked = events.filter((e) => e.severity !== "info").sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.lap_from - b.lap_from);
  return ranked[0] ?? null;
}

/** Two or three sentences: how many laps, the best one and the spread, and the one event to look at first. */
export function sessionSummary(report: Pick<SessionReport, "laps" | "events">): string[] {
  const out: string[] = [];
  const timed = timedLaps(report.laps);
  const n = report.laps.length;
  if (n === 0) return ["This session has no laps."];
  out.push(`${n} ${n === 1 ? "lap" : "laps"}, ${timed.length} of them timed and valid.`);
  if (timed.length > 0) {
    const best = timed.reduce((a, b) => ((b.lap_time_s as number) < (a.lap_time_s as number) ? b : a));
    const worst = timed.reduce((a, b) => ((b.lap_time_s as number) > (a.lap_time_s as number) ? b : a));
    const spread = (worst.lap_time_s as number) - (best.lap_time_s as number);
    out.push(
      timed.length === 1
        ? `Your best was ${formatLapTime(best.lap_time_s)} on lap ${best.lap_no}.`
        : `Your best was ${formatLapTime(best.lap_time_s)} on lap ${best.lap_no}, and your timed laps were within ${spread.toFixed(2)} s of each other.`,
    );
  }
  const top = headlineEvent(report.events);
  if (top) out.push(`Look at first: ${top.sentence.charAt(0).toLowerCase()}${top.sentence.slice(1)}`);
  return out;
}
