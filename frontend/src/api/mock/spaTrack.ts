// The Spa corner map and the landmarks derived from the real reference lap (lap 4 of the 3 Nov recording).
import type { Corner, Landmark } from "../types";

export const SPA_TRACK_LENGTH_M = 6979;

/** Corners from speed minima and steering peaks on the reference lap. */
const APEXES: { id: string; name: string; apex: number; complex?: string }[] = [
  { id: "lasource", name: "La Source", apex: 279 },
  { id: "eaurouge", name: "Eau Rouge", apex: 907, complex: "Raidillon" },
  { id: "raidillon", name: "Raidillon", apex: 1008, complex: "Raidillon" },
  { id: "lescombes1", name: "Les Combes 1", apex: 2309, complex: "Les Combes" },
  { id: "lescombes2", name: "Les Combes 2", apex: 2400, complex: "Les Combes" },
  { id: "bruxelles", name: "Bruxelles", apex: 2942 },
  { id: "t9", name: "T9", apex: 3180 },
  { id: "pouhon1", name: "Pouhon 1", apex: 3726, complex: "Pouhon" },
  { id: "pouhon2", name: "Pouhon 2", apex: 4010, complex: "Pouhon" },
  { id: "fagnes1", name: "Fagnes 1", apex: 4400, complex: "Fagnes" },
  { id: "fagnes2", name: "Fagnes 2", apex: 4539, complex: "Fagnes" },
  { id: "stavelot", name: "Stavelot", apex: 4821 },
  { id: "paulfrere", name: "Paul Frère", apex: 5022 },
  { id: "blanchimont", name: "Blanchimont", apex: 6025 },
  { id: "busstop", name: "Bus Stop", apex: 6669, complex: "Bus Stop" },
];

export interface CornerSignals {
  brake: ArrayLike<number>;
  throttle: ArrayLike<number>;
}

const FULL_THROTTLE = 0.95;
const BRAKE_OFF = 0.05;
const LEAD_IN_M = 50;

/**
 * Where the braking or lift phase before `apex` began: the last point before the apex with brake < 0.05 and
 * throttle >= 0.95, searching back no further than `floor`. null for a flat corner (full throttle at the apex)
 * or when there is no such point within the bound.
 */
export function phaseStart(sig: CornerSignals, apex: number, floor: number): number | null {
  const full = (i: number) => sig.brake[i] < BRAKE_OFF && sig.throttle[i] >= FULL_THROTTLE;
  if (full(apex)) return null;
  for (let i = apex - 1; i >= Math.max(0, floor); i--) if (full(i)) return i;
  return null;
}

/**
 * end = min(midpoint to the next apex, apex + 150). start = the braking/lift phase start on the reference lap minus 50 m,
 * clamped to the midpoint to the previous apex; flat corners keep max(midpoint, apex - 200). Track ends clamp to 0 and the length.
 */
export function spaCorners(ref?: CornerSignals, lengthM: number = SPA_TRACK_LENGTH_M): Corner[] {
  return APEXES.map((c, i, all) => {
    const prevMid = i > 0 ? Math.round((all[i - 1].apex + c.apex) / 2) : 0;
    const nextMid = i < all.length - 1 ? (c.apex + all[i + 1].apex) / 2 : lengthM;
    const phase = ref ? phaseStart(ref, c.apex, prevMid) : null;
    const start = phase !== null ? Math.max(prevMid, phase - LEAD_IN_M) : Math.max(prevMid, c.apex - 200);
    return {
      id: c.id, name: c.name, complex: c.complex ?? null, approx: false, apex_m: c.apex,
      start_m: Math.round(start),
      end_m: Math.round(Math.min(nextMid, c.apex + 150)),
    };
  });
}

export interface LapSignals {
  brake: ArrayLike<number>;
  kerb: ArrayLike<number>;
}

/** Contiguous runs of kerb == 1, inclusive indexes. */
export function kerbRuns(kerb: ArrayLike<number>): { start: number; end: number }[] {
  const runs: { start: number; end: number }[] = [];
  let start = -1;
  for (let i = 0; i <= kerb.length; i++) {
    const on = i < kerb.length && kerb[i] === 1;
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push({ start, end: i - 1 });
      start = -1;
    }
  }
  return runs;
}

/** First index in [start, apex] where brake >= threshold, or null. */
export function brakeOnset(brake: ArrayLike<number>, start: number, apex: number, threshold = 0.1): number | null {
  const last = Math.min(apex, brake.length - 1);
  for (let i = Math.max(0, start); i <= last; i++) if (brake[i] >= threshold) return i;
  return null;
}

/** Brake boards the mock treats as already confirmed by the user, so landmark cues show up in the coach text. */
export const CONFIRMED_BOARDS: ReadonlySet<string> = new Set(["busstop-board100", "lasource-board100"]);

const KERB_NEAR_APEX_M = 15;

/** Pure: kerb landmarks (detected) and brake boards (low unless in `confirmed`) for the given corners from one lap's signals. */
export function deriveLandmarks(corners: Corner[], lap: LapSignals, confirmed: ReadonlySet<string> = CONFIRMED_BOARDS): Landmark[] {
  const out: Landmark[] = [];
  const runs = kerbRuns(lap.kerb);
  for (const c of corners) {
    let k = 0;
    for (const r of runs) {
      if (r.start < c.start_m || r.start > c.end_m) continue;
      // Adjacent corners share a boundary: a run belongs to the corner whose apex is closest.
      const rival = corners.find(
        (o) => o !== c && r.start >= o.start_m && r.start <= o.end_m && Math.abs(o.apex_m - r.start) < Math.abs(c.apex_m - r.start),
      );
      if (rival) continue;
      k++;
      const d = r.start - c.apex_m;
      const kind = d < -KERB_NEAR_APEX_M ? "kerb_entry" : d <= KERB_NEAR_APEX_M ? "kerb_apex" : "kerb_exit";
      const label = kind === "kerb_entry" ? "entry kerb" : kind === "kerb_apex" ? "apex kerb" : "exit kerb";
      out.push({ id: `${c.id}-kerb${k}`, label, kind, distance_m: r.start, corner_id: c.id, confidence: "detected" });
    }
    const onset = brakeOnset(lap.brake, c.start_m, c.apex_m);
    if (onset !== null) {
      for (const [name, offset] of [["150", -50], ["100", 0], ["50", 50]] as const) {
        const id = `${c.id}-board${name}`;
        out.push({
          id, label: `${name} board`, kind: "brake_board", distance_m: onset + offset, corner_id: c.id,
          confidence: confirmed.has(id) ? "confirmed" : "low",
        });
      }
    }
  }
  return out;
}
