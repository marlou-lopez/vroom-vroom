import type { Corner, CornerMetrics, Landmark, TrackMap } from "../api/types";
import { describeAgainst } from "./landmarkPhrase";

/** One metric of one corner: the lap's value, the reference's and lap minus reference. Null where a side has no value. */
export interface Cell {
  lap: number | null;
  ref: number | null;
  diff: number | null;
}

export interface CornerRow {
  corner: Corner;
  /** Lap minus reference over the corner: positive = lost. */
  deltaS: number;
  /** Brake point in metres from the apex (negative = before it); difference: positive = later. */
  brake: Cell;
  peakBrake: Cell;
  minSpeed: Cell;
  /** Where the minimum speed is, in metres from the apex. Difference: positive = later. */
  minSpeedAt: Cell;
  /** Throttle pickup in metres from the apex; difference: positive = later. */
  throttle: Cell;
  exitSpeed: Cell;
  coast: Cell;
  overlap: Cell;
  steer: Cell;
  /** Landmark phrases for the hover (null where no usable landmark is close). */
  brakeHint: { lap: string | null; ref: string | null };
  throttleHint: { lap: string | null; ref: string | null };
}

/** Signed distance a - b along the track, wrapped to +-length/2 so a corner over the start line still compares well. */
export function wrapDiff(a: number, b: number, length: number): number {
  let d = a - b;
  if (length > 0) {
    if (d > length / 2) d -= length;
    else if (d < -length / 2) d += length;
  }
  return d;
}

const cell = (lap: number | null, ref: number | null): Cell => ({
  lap, ref, diff: lap !== null && ref !== null ? lap - ref : null,
});

/** A cell of positions (grid metres) shown relative to the apex: lap and ref are offsets, the difference is the shift between them. */
function posCell(lap: number | null, ref: number | null, apex: number, length: number): Cell {
  const off = (p: number | null) => (p === null ? null : wrapDiff(p, apex, length));
  const l = off(lap);
  const r = off(ref);
  return { lap: l, ref: r, diff: l !== null && r !== null ? l - r : null };
}

const usable = (l: Landmark) => l.confidence !== "low";

/** One row per corner of the comparison that the track map knows, in map order. */
export function cornerRows(corners: CornerMetrics[], map: TrackMap | null): CornerRow[] {
  if (!map) return [];
  const byId = new Map(map.corners.map((c) => [c.id, c]));
  const order = new Map(map.corners.map((c, i) => [c.id, i]));
  const L = map.length_m;
  const rows: CornerRow[] = [];
  for (const m of corners) {
    const corner = byId.get(m.corner_id);
    if (!corner) continue;
    const { lap, ref } = m;
    const anchors = map.landmarks.filter((l) => l.corner_id === corner.id && usable(l));
    const kerbApex = anchors.filter((a) => a.kind === "kerb_apex");
    const hint = (pos: number | null, a: Landmark[]) => (pos === null ? null : describeAgainst(pos, a));
    rows.push({
      corner, deltaS: m.delta_s,
      // Positions are metres from the apex (negative = before it); a positive difference means later than the reference.
      brake: posCell(lap.brake_onset_m, ref.brake_onset_m, corner.apex_m, L),
      peakBrake: cell(lap.peak_brake, ref.peak_brake),
      minSpeed: cell(lap.min_speed_kmh, ref.min_speed_kmh),
      minSpeedAt: posCell(lap.min_speed_m, ref.min_speed_m, corner.apex_m, L),
      throttle: posCell(lap.throttle_pickup_m, ref.throttle_pickup_m, corner.apex_m, L),
      exitSpeed: cell(lap.exit_speed_kmh, ref.exit_speed_kmh),
      coast: cell(lap.coast_s, ref.coast_s),
      overlap: cell(lap.overlap_s, ref.overlap_s),
      steer: cell(lap.steer_corrections, ref.steer_corrections),
      brakeHint: { lap: hint(lap.brake_onset_m, anchors), ref: hint(ref.brake_onset_m, anchors) },
      throttleHint: { lap: hint(lap.throttle_pickup_m, kerbApex), ref: hint(ref.throttle_pickup_m, kerbApex) },
    });
  }
  return rows.sort((a, b) => (order.get(a.corner.id) ?? 0) - (order.get(b.corner.id) ?? 0));
}

export type CornerSort = "track" | "loss";

/** Track order, or the biggest time loss first (gains last). */
export function sortRows(rows: CornerRow[], by: CornerSort): CornerRow[] {
  return by === "track" ? rows : [...rows].sort((a, b) => b.deltaS - a.deltaS);
}

/** "12 m later" / "8 m earlier" / "same" for a position shift, where positive `diff` means later. */
export function shiftWord(diff: number | null): string {
  if (diff === null) return "–";
  const m = Math.round(Math.abs(diff));
  if (m === 0) return "same";
  return `${m} m ${diff > 0 ? "later" : "earlier"}`;
}
