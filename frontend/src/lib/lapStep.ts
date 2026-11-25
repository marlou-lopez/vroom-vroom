// Lap stepping for the one-app scope line (vroom-pnw.61): which laps can be stepped to, each lap's gap, and the ↑/↓ keys.
import { effectiveValid, type LapWithRef } from "../api/types";
import { formatGap } from "./idealGauge";
import { isTypingTarget } from "./shortcuts";

/** The laps you can step through: timed flying laps, plus the current lap whatever it is. */
export function timedLaps(laps: LapWithRef[], currentId: string): LapWithRef[] {
  return laps.filter((l) => (l.kind === "flying" && l.lap_time_s) || l.lap_id === currentId);
}

/** The session's fastest valid flying lap time, or null. */
export function bestLapTime(laps: LapWithRef[]): number | null {
  let best: number | null = null;
  for (const l of laps) if (l.kind === "flying" && l.lap_time_s && effectiveValid(l) && (best === null || l.lap_time_s < best)) best = l.lap_time_s;
  return best;
}

/** "best", "+0.412" or "" (invalid or untimed): a lap's gap to the session's best lap. */
export function lapGapText(l: LapWithRef, best: number | null): string {
  if (best === null || !l.lap_time_s || l.kind !== "flying" || !effectiveValid(l)) return "";
  const gap = l.lap_time_s - best;
  return gap === 0 ? "best" : formatGap(gap);
}

/** The lap one step before (-1) or after (1) the current one in the list, or null at an end or when the lap is not listed. */
export function stepLapId(timed: LapWithRef[], currentId: string, dir: 1 | -1): string | null {
  const i = timed.findIndex((l) => l.lap_id === currentId);
  if (i < 0) return null;
  return timed[i + dir]?.lap_id ?? null;
}

/** ↑ is the previous lap, ↓ the next; null for other keys, modified keys, and fields or sliders that own the arrows. */
export function lapKeyDir(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, target: Element | null): 1 | -1 | null {
  if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return null;
  if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return null;
  if (isTypingTarget(target) || target?.closest("[role=slider], [role=tab], [role=radio], [role=listbox], [role=option], [role=menuitem], [role=toolbar]")) return null;
  return e.key === "ArrowDown" ? 1 : -1;
}

/** The session laps that can be the reference for the lap being studied: timed flying laps except that lap itself. */
export function refChoices(laps: LapWithRef[], currentId: string): LapWithRef[] {
  return laps.filter((l) => l.kind === "flying" && l.lap_time_s && l.lap_id !== currentId);
}

/** The next (1) or previous (-1) reference lap in the list, wrapping round; from a reference outside the list, the first or last. Null for an empty list. */
export function cycleRefId(choices: LapWithRef[], refId: string, dir: 1 | -1): string | null {
  if (choices.length === 0) return null;
  const i = choices.findIndex((l) => l.lap_id === refId);
  if (i < 0) return choices[dir === 1 ? 0 : choices.length - 1].lap_id;
  return choices[(i + dir + choices.length) % choices.length].lap_id;
}

/** R picks the next reference lap, Shift+R the previous; null for other keys, other modifiers, and typing or open popups. */
export function refKeyDir(e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }, target: Element | null): 1 | -1 | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (e.key !== "r" && e.key !== "R") return null;
  if (isTypingTarget(target)) return null;
  return e.shiftKey ? -1 : 1;
}
