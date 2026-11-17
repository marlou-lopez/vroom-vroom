// EXPERIMENTAL (vroom-pnw.26): the per-lap stint stats of the real Monza race of 9 Nov 2026 (26 laps, McLaren 720S GT3 Evo),
// served at /mock/monza-stint-2026-11-09.json and made by tools/extract-stint.py. Fetched on first use, like the survey.
import type { StintLap } from "../types";

export const MONZA_STINT_URL = "/mock/monza-stint-2026-11-09.json";

export interface StintFile {
  source: string;
  note?: string;
  session_type: string;
  car_class: string;
  weather?: string;
  laps: StintLap[];
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
