// The per-lap stint stats of the real Monza race of 9 Nov 2026 (26 laps, McLaren 720S GT3 Evo), served at
// /mock/monza-stint-2026-11-09.json and made by tools/extract-stint.py. The mock turns them into a session with lap metadata
// only (no 1 m traces) and into its stints. Fetched on first use, like the survey.
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

/** Splits laps into stints after each in lap: the next lap (an out lap) starts the next stint. The backend does the same. */
export function splitStints(laps: StintLap[]): Stint[] {
  const stints: Stint[] = [];
  let cur: StintLap[] = [];
  for (const lap of laps) {
    cur.push(lap);
    if (lap.kind === "in") {
      stints.push({ stint_no: stints.length + 1, laps: cur });
      cur = [];
    }
  }
  if (cur.length) stints.push({ stint_no: stints.length + 1, laps: cur });
  return stints;
}
