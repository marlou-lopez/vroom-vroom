// EXPERIMENTAL (vroom-pnw.26): pure logic for the Stint view. Per-lap consumption, the lap-time fall-off line and the tank range.
import type { StintLap, Wheels } from "../api/types";

/** Why a lap is left out of the fall-off fit. */
export type FitExclusion = "out" | "in" | "incomplete" | "invalid" | "slow";

export interface StintRow {
  lap: StintLap;
  /** Litres used on the lap; null when the tank was filled during it (a pit stop). */
  fuelUsed: number | null;
  /** Virtual energy used, percent of the tank; null without virtual energy or when it was refilled. */
  energyUsed: number | null;
  /** Tread worn on the lap, percent, per wheel (previous lap's end minus this lap's end); null on the first lap. */
  wear: Wheels | null;
  /** null: the lap is in the fall-off fit. */
  excluded: FitExclusion | null;
}

/** A lap slower than this multiple of the median clean lap is left out of the fit (traffic, a mistake). */
export const SLOW_LAP_FACTOR = 1.02;

const WHEELS = ["fl", "fr", "rl", "rr"] as const;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const used = (start: number | null, end: number | null) => (start === null || end === null || end > start ? null : start - end);

export function stintRows(laps: StintLap[]): StintRow[] {
  const clean = laps.filter((l) => l.kind === "flying" && l.valid && l.lap_time_s);
  const cut = clean.length ? median(clean.map((l) => l.lap_time_s!)) * SLOW_LAP_FACTOR : Infinity;
  return laps.map((lap, i) => {
    const prev = i > 0 ? laps[i - 1].tyre_wear_end_pct : null;
    let excluded: FitExclusion | null = null;
    if (lap.kind === "out" || lap.kind === "in" || lap.kind === "incomplete") excluded = lap.kind;
    else if (!lap.valid || !lap.lap_time_s) excluded = "invalid";
    else if (lap.lap_time_s > cut) excluded = "slow";
    return {
      lap,
      fuelUsed: used(lap.fuel_start_l, lap.fuel_end_l),
      energyUsed: used(lap.energy_start_pct, lap.energy_end_pct),
      wear: prev ? (Object.fromEntries(WHEELS.map((w) => [w, prev[w] - lap.tyre_wear_end_pct[w]])) as unknown as Wheels) : null,
      excluded,
    };
  });
}

export interface Falloff {
  /** Seconds per lap (positive: getting slower). */
  slope: number;
  /** Fitted lap time at lap number 0. */
  intercept: number;
  n: number;
}

/** Least-squares line of lap time against lap number over the laps in the fit. null with fewer than 3 laps. */
export function falloff(rows: StintRow[]): Falloff | null {
  const pts = rows.filter((r) => r.excluded === null).map((r) => [r.lap.lap_no, r.lap.lap_time_s!] as const);
  const n = pts.length;
  if (n < 3) return null;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  const sxx = pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
  const sxy = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0);
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  return { slope, intercept: my - slope * mx, n };
}

export interface StintSummary {
  falloff: Falloff | null;
  /** Mean use per flying lap (invalid laps count: they burn fuel too). */
  fuelPerLap: number | null;
  energyPerLap: number | null;
  wearPerLap: Wheels | null;
  /** Laps a full start load lasts at that rate: the first lap's start level divided by the use per lap. */
  fuelRangeLaps: number | null;
  energyRangeLaps: number | null;
  /** Which runs out first. */
  limit: "fuel" | "energy" | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export function stintSummary(rows: StintRow[]): StintSummary {
  const flying = rows.filter((r) => r.lap.kind === "flying");
  const fuelPerLap = mean(flying.flatMap((r) => (r.fuelUsed === null ? [] : [r.fuelUsed])));
  const energyPerLap = mean(flying.flatMap((r) => (r.energyUsed === null ? [] : [r.energyUsed])));
  const wears = flying.flatMap((r) => (r.wear ? [r.wear] : []));
  const wearPerLap = wears.length
    ? (Object.fromEntries(WHEELS.map((w) => [w, mean(wears.map((x) => x[w]))])) as unknown as Wheels)
    : null;
  const first = rows[0]?.lap;
  const fuelRangeLaps = first && fuelPerLap ? first.fuel_start_l / fuelPerLap : null;
  const energyRangeLaps = first && energyPerLap && first.energy_start_pct !== null ? first.energy_start_pct / energyPerLap : null;
  const limit = fuelRangeLaps === null ? null : energyRangeLaps !== null && energyRangeLaps < fuelRangeLaps ? "energy" : "fuel";
  return { falloff: falloff(rows), fuelPerLap, energyPerLap, wearPerLap, fuelRangeLaps, energyRangeLaps, limit };
}

export interface FalloffPlot {
  /** One point per timed lap; `excluded` as in StintRow. */
  points: { x: number; y: number; lapNo: number; excluded: FitExclusion | null }[];
  /** The fit line over the fitted laps' range, "" without a fit. */
  fit: string;
  lo: number;
  hi: number;
}

/** Plot coordinates (viewBox w × h, y down, faster at the top) for the laps that have a time and are not invalid. */
export function falloffPlot(rows: StintRow[], fit: Falloff | null, w: number, h: number, pad = 12): FalloffPlot {
  const timed = rows.filter((r) => r.lap.lap_time_s && r.excluded !== "invalid");
  const fitted = rows.filter((r) => r.excluded === null).map((r) => r.lap.lap_time_s!);
  if (timed.length === 0 || fitted.length === 0) return { points: [], fit: "", lo: 0, hi: 0 };
  // The y range follows the fitted laps, so one slow start lap does not flatten the trend; points outside are clamped.
  const lo = Math.min(...fitted);
  const hi = Math.max(...fitted);
  const span = hi - lo || 1;
  const x0 = Math.min(...timed.map((r) => r.lap.lap_no));
  const x1 = Math.max(...timed.map((r) => r.lap.lap_no));
  const sx = (n: number) => (x1 === x0 ? w / 2 : pad + ((n - x0) / (x1 - x0)) * (w - 2 * pad));
  const sy = (v: number) => Math.min(h, Math.max(0, pad + ((v - lo) / span) * (h - 2 * pad)));
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const points = timed.map((r) => ({ x: r1(sx(r.lap.lap_no)), y: r1(sy(r.lap.lap_time_s!)), lapNo: r.lap.lap_no, excluded: r.excluded }));
  let line = "";
  if (fit) {
    const ns = rows.filter((r) => r.excluded === null).map((r) => r.lap.lap_no);
    const a = Math.min(...ns), b = Math.max(...ns);
    line = `M${r1(sx(a))} ${r1(sy(fit.intercept + fit.slope * a))}L${r1(sx(b))} ${r1(sy(fit.intercept + fit.slope * b))}`;
  }
  return { points, fit: line, lo, hi };
}
