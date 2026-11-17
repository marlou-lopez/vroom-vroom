import type { CompareResponse, Corner } from "../api/types";
import { causeOf, type Cause } from "./cornerCause";

export interface CornerLoss {
  cornerId: string;
  name: string;
  /** Lap minus reference over the corner: positive = lost. */
  deltaS: number;
  cause: Cause;
  startM: number;
}

export interface BiggestLosses {
  losses: CornerLoss[];
  gain: CornerLoss | null;
}

/** One word for the cause chip. */
export const CAUSE_WORD: Record<Cause, string> = {
  brake: "braking",
  speed: "minimum speed",
  throttle: "throttle",
  steering: "steering",
};

/** Corners whose delta rounds to nothing are not worth listing. */
const MIN_DELTA_S = 0.001;

/**
 * The `count` corners with the largest time loss and the single biggest gain, from the comparison's per-corner metrics
 * (no coach call). Null when the lap is its own reference.
 */
export function biggestLosses(cmp: CompareResponse, corners: Corner[], count = 3): BiggestLosses | null {
  if (cmp.lap_id === cmp.ref_lap_id) return null;
  const byId = new Map(corners.map((c) => [c.id, c]));
  const all: CornerLoss[] = [];
  for (const m of cmp.corners) {
    const c = byId.get(m.corner_id);
    if (!c) continue;
    all.push({ cornerId: c.id, name: c.name, deltaS: m.delta_s, // A gain is scored with the laps swapped: what the reference did worse, i.e. why this lap was quicker.
      cause: causeOf(m.delta_s < 0 ? { ...m, lap: m.ref, ref: m.lap } : m), startM: c.start_m });
  }
  const losses = all.filter((l) => l.deltaS >= MIN_DELTA_S).sort((a, b) => b.deltaS - a.deltaS).slice(0, count);
  const gain = all.filter((l) => l.deltaS <= -MIN_DELTA_S).sort((a, b) => a.deltaS - b.deltaS)[0] ?? null;
  return { losses, gain };
}
