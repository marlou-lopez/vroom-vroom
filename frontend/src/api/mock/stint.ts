// The per-lap stint stats of the real Monza race of 9 Nov 2026 (26 laps, McLaren 720S GT3 Evo), served at
// /mock/monza-stint-2026-11-09.json and made by tools/extract-stint.py. The mock turns them into a session with lap metadata
// only (no 1 m traces) and into its stints. Fetched on first use, like the survey.
import { falloff, fuelCorrectedFalloff, GT3_FUEL_EFFECT, stintRows, type FuelEffect } from "../../lib/stint";
import type { Stint, StintLap } from "../types";

export const MONZA_STINT_URL = "/mock/monza-stint-2026-11-09.json";

export interface StintFile {
  source: string;
  note?: string;
  session_type: string;
  car_class: string;
  weather?: string;
  laps: Omit<StintLap, "lap_id">[];
}

export type StintLoader = () => Promise<StintFile | null>;

let cached: Promise<StintFile> | null = null;

/** Default browser loader: one fetch, cached for the page's lifetime (a failure is not cached). */
export const fetchMonzaStint: StintLoader = () => {
  if (!cached) {
    cached = fetch(MONZA_STINT_URL)
      .then((res) => {
        if (!res.ok) throw new Error(`${MONZA_STINT_URL}: HTTP ${res.status}`);
        return res.json() as Promise<StintFile>;
      })
      .catch((e) => {
        cached = null;
        throw e;
      });
  }
  return cached;
};

/**
 * The fuel-weight effect per `SessionMeta.car_class`. A class without an entry gets no corrected fall-off (null), not a guess.
 * The backend keeps the same table in config/cars.yaml (vroom-9ki.20).
 */
export const FUEL_EFFECT_BY_CLASS: Record<string, FuelEffect> = { GT3: GT3_FUEL_EFFECT };

/** Splits laps into stints after each in lap: the next lap (an out lap) starts the next stint. The backend does the same. */
export function splitStints(laps: StintLap[], carClass: string): Stint[] {
  const stints: Stint[] = [];
  const add = (cur: StintLap[]) => stints.push({ stint_no: stints.length + 1, laps: cur, ...stintFalloffs(cur, FUEL_EFFECT_BY_CLASS[carClass]) });
  let cur: StintLap[] = [];
  for (const lap of laps) {
    cur.push(lap);
    if (lap.kind === "in") {
      add(cur);
      cur = [];
    }
  }
  if (cur.length) add(cur);
  return stints;
}

/** The raw and fuel-corrected fall-off of one stint, computed with the logic in lib/stint.ts (racecoach does the same, vroom-9ki.20). */
function stintFalloffs(laps: StintLap[], effect: FuelEffect | undefined): Pick<Stint, "falloff" | "falloff_fuel_corrected"> {
  const rows = stintRows(laps);
  const raw = falloff(rows);
  const c = raw && effect ? fuelCorrectedFalloff(rows, effect) : null;
  return {
    falloff: raw && { slope_s_per_lap: raw.slope, n_laps: raw.n },
    falloff_fuel_corrected: c && {
      slope_s_per_lap: c.slope,
      fuel_gain_s_per_lap: c.fuelGainPerLap,
      kg_per_lap: c.kgPerLap,
      s_per_kg: c.secPerKg,
      assumption: { kg_per_l: effect!.kgPerL, lap_fraction_per_kg: effect!.lapFractionPerKg, source: effect!.source },
    },
  };
}
