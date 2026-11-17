import type { ChannelArrays, TrackMap } from "../api/types";
import { runsOf, type Run } from "./driverAids";
import { cornerAt, nearestCorner } from "./trackmap";

// Where a lap's wheels left the track (vroom-pnw.24). LMU records no track-limit or invalidation event, so the invalid lap's
// cause is a guess: the first stretch with at least two wheels on grass or gravel. LMU's real rule is not documented.

/** Wheels on grass or gravel that make a mark: one wheel is not enough to show, nor to call a limit. */
export const MIN_WHEELS_OFF = 2;
/** Stretches closer than this many metres merge into one mark (the channel is 5 Hz, so a long excursion flickers at its ends). */
export const OFF_MERGE_GAP_M = 10;

export type OffTrackChannels = Pick<ChannelArrays, "wheels_off">;

/** The stretches (inclusive grid indices, so metres) where at least `MIN_WHEELS_OFF` wheels were off the track. */
export function offTrackRuns(ch: OffTrackChannels): Run[] {
  const w = ch.wheels_off;
  return runsOf((i) => w[i] >= MIN_WHEELS_OFF, w.length, OFF_MERGE_GAP_M);
}

/** The stretch most likely to have invalidated the lap: the first one (the game flags a lap at the first breach). null when there is none. */
export function likelyInvalidRun(runs: Run[]): Run | null {
  return runs[0] ?? null;
}

/**
 * Where on the lap: "Raidillon exit", "Blanchimont", "near Pouhon" or, with no corner list, the distance.
 * A corner's first third is its entry and its last third its exit; the middle is the corner itself.
 */
export function placeAt(map: TrackMap | null, d: number): string {
  if (!map || map.corners.length === 0) return `${Math.round(d).toLocaleString("en-US")} m`;
  const inside = cornerAt(map, d);
  if (!inside) return `near ${nearestCorner(map, d)?.name ?? "a corner"}`;
  const L = Math.max(map.length_m, 1);
  const wrap = (x: number) => ((x % L) + L) % L;
  const span = wrap(inside.end_m - inside.start_m);
  const frac = span > 0 ? wrap(d - inside.start_m) / span : 0.5;
  return frac < 1 / 3 ? `${inside.name} entry` : frac > 2 / 3 ? `${inside.name} exit` : inside.name;
}

/** The lap picker's hint for an invalid lap, e.g. "invalid: Raidillon exit?"; null when the lap has no wheels-off stretch. */
export function invalidHint(ch: OffTrackChannels, map: TrackMap | null): string | null {
  const run = likelyInvalidRun(offTrackRuns(ch));
  return run ? `invalid: ${placeAt(map, run.start)}?` : null;
}
