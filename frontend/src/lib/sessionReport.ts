// Pure logic for the session report (vroom-bi4.11): fixed rules find events over a whole session, judged against the session
// itself and the working windows in reportWindows.ts. Causes are stated as co-occurrence only ("coincides with"), never "because".
// The mock calls this today; racecoach does the same in the backend, and an LLM may rephrase the sentences later under the number guard.
import {
  type Axles, type ReportCategory, type ReportCoincidence, type ReportEvent, type ReportLap, type ReportSeverity, type SessionReport,
  type SettingName, type Stint, type StintLap, type Corner, type LapKind, type Wheels, REPORT_CATEGORIES,
} from "../api/types";
import { type AidRuns, type Run } from "./driverAids";
import { median, fitLine, SLOW_LAP_FACTOR, stintRows, stintSummary } from "./stint";
import { windowList, windowsFor, type ClassWindows, type Window } from "./reportWindows";

export interface ReportLapInput {
  lap_id: string;
  lap_no: number;
  kind: LapKind;
  lap_time_s: number | null;
  valid: boolean;
  has_trace: boolean;
}

/** What a lap's 1 m trace gives the report: the aid runs and each corner's time (seconds between its start and end metre). */
export interface TraceFacts {
  aids: AidRuns | null;
  corner_times_s: number[];
}

export interface SettingChange { setting: SettingName; value: number; previous: number; lap_no: number; dist_m: number }

export interface ReportInput {
  session_id: string;
  car_class: string;
  track_length_m: number;
  laps: ReportLapInput[];
  /** Per-lap stint stats; null when the session has none. */
  stats: StintLap[] | null;
  /** The session's stints (from the stats); empty without stats. */
  stints: Stint[];
  /** The in-car setting changes and starting values; null when the recording has none. */
  settings: { initial: Partial<Record<SettingName, number>>; events: SettingChange[] } | null;
  corners: Corner[];
  /** By lap number; only laps with a trace. */
  traces: Map<number, TraceFacts>;
  /** Per-lap ABS / TC metres and activations, from the recording. By lap number. */
  aid_activation: Map<number, { abs_m: number; tc_m: number }>;
}

/** Rule thresholds: first guesses, like the windows. */
export const RULES = {
  /** Laps a tyre value must be outside its window before it is an event. */
  tyreMinLaps: 2,
  brakeTempMinLaps: 1,
  brakeRatioMinLaps: 2,
  /** Smallest time a coincidence must show to be reported (s). */
  minLostS: 0.05,
  minCornerLostS: 0.03,
  lockupMinLaps: 2,
  wheelspinMinLaps: 2,
  /**
   * Lock-up and wheelspin trend per corner (vroom-bij): traced flying laps, first third against last third (at least `cornerTrendMinLaps`
   * laps in all). Reported when one third has at least `cornerTrendMinCount` runs in the corner and the two differ by `cornerTrendMinChange`.
   * The 'repeated' event is the per-corner `lockups` / `wheelspins` event above (`lockupMinLaps`, `wheelspinMinLaps`).
   */
  cornerTrendMinLaps: 6,
  cornerTrendMinCount: 3,
  cornerTrendMinChange: 2,
  /** Mean metres per lap with ABS / TC active in one corner before it is reported, and at most this many corners of each. */
  absCornerMinM: 15,
  tcCornerMinM: 10,
  maxAidCorners: 3,
  /** Aid trend: change across the session as a share of the first lap's value, and in metres. */
  trendShare: 0.2,
  trendMinM: 30,
  /** Fall-off from this s/lap on is reported; from `falloffWatch` a watch, from `falloffProblem` a problem. */
  falloffMin: 0.05,
  falloffWatch: 0.1,
  falloffProblem: 0.3,
  trackTempDriftC: 2,
  /** An out lap's disc temperature this far below the flying laps before the stop is reported. */
  pitCoolingShare: 0.2,
  /** 'Vs your best laps': the best laps are the fastest `bestShare` of the timed flying laps, at least `bestMinSet`; at least `bestMinOthers`
   * other laps must exist to compare, otherwise the comparison is skipped and the report says so. */
  bestShare: 0.2,
  bestMinSet: 3,
  bestMinOthers: 2,
  /** A lap is compared when an axle value differs from the best laps' mean by this much (°C, kPa), and at least `bestMinLaps` laps must. */
  bestTempDiffC: 5,
  bestPressureDiffKpa: 5,
  bestBrakeDiffC: 40,
  bestMinLaps: 2,
} as const;

const r = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const axles = (w: Wheels): Axles => ({ front: r((w.fl + w.fr) / 2, 1), rear: r((w.rl + w.rr) / 2, 1) });
const AXLES = ["front", "rear"] as const;
const SETTING_NAME: Record<SettingName, string> = { ABSLevel: "ABS", TCLevel: "TC", TCCut: "TC cut", TCSlipAngle: "TC slip", FuelMixtureMap: "Engine map" };
/** Severity from the share of the considered laps (or window width) affected. */
const sev = (share: number): ReportSeverity => (share >= 0.5 ? "problem" : share >= 0.15 ? "watch" : "info");
/** Severity from how far outside its window a value is, as a share of the window's width. */
const gapSev = (share: number): ReportSeverity => (share >= 0.25 ? "problem" : share >= 0.1 ? "watch" : "info");
const isTimed = (l: ReportLapInput) => l.kind === "flying" && l.valid && (l.lap_time_s ?? 0) > 0;

const UNAVAILABLE_STATS = "This session has no stint stats (tyre, brake, fuel and track temperatures).";

interface Draft {
  category: ReportCategory; kind: string; severity: ReportSeverity; laps: number[]; numbers: Record<string, number>;
  /** The sentence, from the numbers (rounded as stored). Must not state a cause. */
  say: (n: Record<string, number>) => string;
  corner?: Corner | null; distance_m?: number | null; coincides?: ReportCoincidence | null;
  /** Look for the corner that lost most on these laps (lap-level events on traced laps). */
  locate?: boolean;
}
type Add = (d: Draft) => void;
type Range = (n: Record<string, number>) => string;
type WithRange = (laps: number[], numbers: Record<string, number>) => Record<string, number>;

export function buildSessionReport(input: ReportInput): SessionReport {
  const { laps, stats, corners } = input;
  const win = windowsFor(input.car_class);
  const statOf = new Map((stats ?? []).map((s) => [s.lap_no, s]));
  const timed = laps.filter(isTimed);
  const best = timed.length ? timed.reduce((a, b) => (b.lap_time_s! < a.lap_time_s! ? b : a)) : null;
  const bestCorners = best ? input.traces.get(best.lap_no)?.corner_times_s ?? null : null;
  const lapOf = new Map(laps.map((l) => [l.lap_no, l]));
  const isTimedNo = (n: number) => { const l = lapOf.get(n); return !!l && isTimed(l); };

  const events: ReportEvent[] = [];
  const unavailable: { category: ReportCategory; reason: string }[] = [];

  /** Seconds slower than the session's best flying lap; null for a lap that is not timed. */
  const lost = (lapNo: number): number | null => {
    const l = lapOf.get(lapNo);
    return best && l && isTimed(l) ? l.lap_time_s! - best.lap_time_s! : null;
  };
  const lapCoincidence = (lapNos: number[]): ReportCoincidence | null => {
    const xs = lapNos.flatMap((n) => { const v = lost(n); return v === null ? [] : [v]; });
    if (!xs.length) return null;
    const m = mean(xs);
    return m >= RULES.minLostS ? { scope: "lap", lost_s: r(m), laps: lapNos.filter((n) => lost(n) !== null) } : null;
  };
  /** The corner on `lapNos` that lost most time against the best lap's corner times, with that mean loss. */
  const worstCorner = (lapNos: number[]): { corner: Corner; lost_s: number } | null => {
    if (!bestCorners) return null;
    const rows = lapNos.flatMap((n) => (best && n !== best.lap_no && isTimedNo(n) ? [input.traces.get(n)?.corner_times_s] : [])).filter((x): x is number[] => !!x);
    if (!rows.length) return null;
    let top: { corner: Corner; lost_s: number } | null = null;
    corners.forEach((c, i) => {
      const m = mean(rows.map((t) => t[i] - bestCorners[i]));
      if (m >= RULES.minCornerLostS && (!top || m > top.lost_s)) top = { corner: c, lost_s: r(m) };
    });
    return top;
  };
  const cornerAt = (d: number): Corner | null => corners.find((c) => d >= c.start_m && d <= c.end_m) ?? null;

  const add = (d: Draft) => {
    const laps_ = [...d.laps].sort((a, b) => a - b);
    const numbers = { ...d.numbers };
    let corner = d.corner ?? null;
    let distance = d.distance_m ?? null;
    const coincides = d.coincides === undefined ? lapCoincidence(laps_) : d.coincides;
    if (coincides) numbers.lost_s = coincides.lost_s;
    let tail = "";
    if (d.locate) {
      const w = worstCorner(laps_);
      if (w) {
        corner = w.corner; distance = w.corner.apex_m; numbers.corner_lost_s = w.lost_s;
      }
    }
    if (coincides) tail = coincides.scope === "corner"
      ? ` It coincides with ${numbers.lost_s.toFixed(2)} s lost in that corner on those laps.`
      : ` It coincides with laps ${numbers.lost_s.toFixed(2)} s slower than the session's best.`;
    if (d.locate && numbers.corner_lost_s !== undefined) tail += ` Most of that time went in ${corner!.name} (${numbers.corner_lost_s.toFixed(2)} s).`;
    events.push({
      id: `${d.category}-${d.kind}-${events.length}`, category: d.category, kind: d.kind, severity: d.severity,
      lap_from: laps_[0], lap_to: laps_[laps_.length - 1],
      corner: corner && { id: corner.id, name: corner.name }, distance_m: distance, numbers, coincides,
      sentence: d.say(numbers) + tail,
    });
  };
  const range = (n: Record<string, number>) => (n.lap_from === n.lap_to ? `lap ${n.lap_from}` : `laps ${n.lap_from} to ${n.lap_to}`);
  const withRange = (laps_: number[], numbers: Record<string, number>) => ({ ...numbers, lap_from: Math.min(...laps_), lap_to: Math.max(...laps_) });

  // ---- tyres and brakes (stint stats) ----
  if (!stats) {
    for (const c of ["tyres", "brakes", "conditions"] as const) unavailable.push({ category: c, reason: UNAVAILABLE_STATS });
  } else if (!win) {
    for (const c of ["tyres", "brakes"] as const) unavailable.push({ category: c, reason: `No working windows for car class ${input.car_class}.` });
  } else {
    tyreEvents(stats, win, add, range, withRange);
    brakeEvents(stats, win, add, range, withRange);
    const need = RULES.bestMinSet + RULES.bestMinOthers;
    const bestSet = timed.length >= need ? [...timed].sort((a, b) => a.lap_time_s! - b.lap_time_s!).slice(0, Math.max(RULES.bestMinSet, Math.ceil(RULES.bestShare * timed.length))) : null;
    if (!bestSet || timed.length - bestSet.length < RULES.bestMinOthers) {
      for (const c of ["tyres", "brakes"] as const) unavailable.push({ category: c, reason: `Too few timed flying laps to compare with your best laps (${timed.length}, need at least ${need}).` });
    } else {
      vsBestEvents(stats, new Set(bestSet.map((l) => l.lap_no)), lapCoincidence, add, range, withRange);
    }
  }

  // ---- driving (traces) ----
  const traced = [...input.traces.entries()].filter(([, t]) => t.aids);
  if (!traced.length) unavailable.push({ category: "driving", reason: "No 1 m traces with driver-aid channels in this session." });
  else drivingEvents(input, traced as [number, TraceFacts & { aids: AidRuns }][], best?.lap_no ?? null, add, range, withRange);

  // ---- settings ----
  if (!input.settings) unavailable.push({ category: "settings", reason: "This recording has no in-car setting events." });
  else {
    const groups = new Map<string, SettingChange[]>();
    for (const e of input.settings.events) groups.set(`${e.setting}/${e.lap_no}`, [...(groups.get(`${e.setting}/${e.lap_no}`) ?? []), e]);
    for (const g of groups.values()) {
      const first = g[0], last = g[g.length - 1];
      const hasTrace = input.traces.has(first.lap_no);
      const inLap = first.dist_m >= 0 && first.dist_m <= input.track_length_m;
      const name = SETTING_NAME[first.setting];
      add({
        category: "settings", kind: "setting_changed", severity: "info", laps: [first.lap_no],
        numbers: withRange([first.lap_no], { before: first.previous, after: last.value, changes: g.length, ...(hasTrace && inLap ? { distance_m: first.dist_m } : {}) }),
        say: (n) => (n.before === n.after
          ? `${name} was changed ${n.changes} times in ${range(n)} and ended where it started (${n.after}).`
          : `${name} was changed in the car from ${n.before} to ${n.after} in ${range(n)}.`),
        corner: hasTrace && inLap ? cornerAt(first.dist_m) : null, distance_m: hasTrace && inLap ? first.dist_m : null,
      });
    }
  }

  // ---- pace ----
  paceEvents(input, timed.length, add, range, withRange);

  // ---- conditions ----
  if (stats) {
    const temps = stats.map((s) => ({ lap: s.lap_no, t: s.track_temp_c }));
    if (temps.length >= 2) {
      const change = temps[temps.length - 1].t - temps[0].t;
      if (Math.abs(change) >= RULES.trackTempDriftC) {
        add({
          category: "conditions", kind: "track_temp_drift", severity: "info", laps: temps.map((t) => t.lap),
          numbers: withRange(temps.map((t) => t.lap), { first_c: r(temps[0].t, 1), last_c: r(temps[temps.length - 1].t, 1), change_c: r(change, 1) }),
          say: (n) => `Track temperature ${change > 0 ? "rose" : "fell"} from ${n.first_c.toFixed(1)} °C to ${n.last_c.toFixed(1)} °C over ${range(n)}.`,
        });
      }
    }
    for (const st of input.stints) {
      const rows = stintRows(st.laps);
      const sum = stintSummary(rows);
      const flying = rows.filter((x) => x.lap.kind === "flying").length;
      // Only when the stint ran to the limit: a full load lasts no more than the stint's laps plus two.
      const limitLaps = sum.limit === "energy" ? sum.energyRangeLaps : sum.fuelRangeLaps;
      if (!sum.limit || flying < 2 || limitLaps === null || limitLaps > st.laps.length + 2) continue;
      const nums = withRange(st.laps.map((l) => l.lap_no), { stint_no: st.stint_no, fuel_laps: r(sum.fuelRangeLaps!, 1), ...(sum.energyRangeLaps !== null ? { energy_laps: r(sum.energyRangeLaps, 1) } : {}) });
      add({
        category: "conditions", kind: `${sum.limit}_limit`, severity: "info", laps: st.laps.map((l) => l.lap_no), coincides: null,
        numbers: nums,
        say: (n) => (sum.limit === "energy"
          ? `In stint ${n.stint_no} virtual energy runs out first: a full start load lasts about ${n.energy_laps.toFixed(1)} laps at this rate, fuel ${n.fuel_laps.toFixed(1)} laps.`
          : `In stint ${n.stint_no} fuel runs out first: a full start load lasts about ${n.fuel_laps.toFixed(1)} laps at this rate${n.energy_laps !== undefined ? `, virtual energy ${n.energy_laps.toFixed(1)} laps` : ""}.`),
      });
    }
  }

  const reportLaps = laps.map((l): ReportLap => {
    const s = statOf.get(l.lap_no);
    let settings: ReportLap["settings"] = null;
    if (input.settings) {
      settings = { ...input.settings.initial };
      for (const e of input.settings.events) if (e.lap_no <= l.lap_no) settings[e.setting] = e.value;
    }
    return {
      lap_id: l.lap_id, lap_no: l.lap_no, kind: l.kind, lap_time_s: l.lap_time_s, valid: l.valid, has_trace: l.has_trace,
      tyre_surface_c: s ? axles(s.tyre_surface_c) : null, tyre_carcass_c: s ? axles(s.tyre_carcass_c) : null,
      tyre_pressure_kpa: s ? axles(s.tyre_pressure_kpa) : null, brake_c: s ? axles(s.brake_c) : null,
      track_temp_c: s?.track_temp_c ?? null, fuel_end_l: s?.fuel_end_l ?? null, energy_end_pct: s?.energy_end_pct ?? null, settings,
    };
  });
  events.sort((a, b) => a.lap_from - b.lap_from || REPORT_CATEGORIES.indexOf(a.category) - REPORT_CATEGORIES.indexOf(b.category));
  return {
    session_id: input.session_id, car_class: input.car_class, compound: win?.compound ?? "unknown",
    laps: reportLaps, events, windows: win ? windowList(win) : [], unavailable,
  };
}


const wheelsOf = (s: StintLap, key: "tyre_surface_c" | "tyre_carcass_c" | "tyre_pressure_kpa" | "brake_c") => axles(s[key]);
const outside = (v: number, w: Window) => (v < w.min ? "low" : v > w.max ? "high" : null);

/** Only flying laps are judged against a window: out, in and incomplete laps run cold, slow or cut short on purpose. */
const settled = (s: StintLap) => s.kind === "flying";

function tyreEvents(stats: StintLap[], win: ClassWindows, add: Add, range: Range, withRange: WithRange) {
  const metrics = [
    ["tyre_surface_c", "surface temperature", "°C", 1], ["tyre_carcass_c", "carcass temperature", "°C", 1], ["tyre_pressure_kpa", "pressure", "kPa", 0],
  ] as const;
  const use = stats.filter(settled);
  for (const [key, label, unit, d] of metrics) {
    for (const axle of AXLES) {
      for (const dir of ["low", "high"] as const) {
        const w = win[key];
        const bad = use.filter((s) => outside(wheelsOf(s, key)[axle], w) === dir);
        if (bad.length < RULES.tyreMinLaps) continue;
        const v = mean(bad.map((s) => wheelsOf(s, key)[axle]));
        const gap = Math.abs(v - (dir === "low" ? w.min : w.max));
        const laps = bad.map((s) => s.lap_no);
        add({
          category: "tyres", kind: `${key}_${dir}`, severity: gapSev(gap / (w.max - w.min)),
          laps, numbers: withRange(laps, { mean: r(v, d), window_min: w.min, window_max: w.max, n_laps: bad.length }),
          say: (n) => `${axle[0].toUpperCase()}${axle.slice(1)} tyre ${label} averaged ${n.mean.toFixed(d)} ${unit} over ${n.n_laps} laps (${range(n)}), ${dir === "low" ? "below" : "above"} the ${n.window_min}-${n.window_max} ${unit} window.`,
          locate: true,
        });
      }
    }
  }
  const sp = win.tyre_spread_c;
  for (const axle of AXLES) {
    const spread = (s: StintLap) => {
      const z = s.tyre_zones_c;
      const [a, b] = axle === "front" ? (["fl", "fr"] as const) : (["rl", "rr"] as const);
      return (Math.abs(z.left[a] - z.right[a]) + Math.abs(z.left[b] - z.right[b])) / 2;
    };
    const bad = use.filter((s) => spread(s) > sp.max);
    if (bad.length < RULES.tyreMinLaps) continue;
    const v = mean(bad.map(spread));
    const laps = bad.map((s) => s.lap_no);
    add({
      category: "tyres", kind: "tyre_spread", severity: sev(bad.length / use.length),
      laps, numbers: withRange(laps, { mean: r(v, 1), window_max: sp.max, n_laps: bad.length }),
      say: (n) => `${axle[0].toUpperCase()}${axle.slice(1)} tyre tread edge-to-edge temperature spread averaged ${n.mean.toFixed(1)} °C over ${n.n_laps} laps (${range(n)}), above the ${n.window_max} °C limit.`,
      locate: true,
    });
  }
}

function brakeEvents(stats: StintLap[], win: ClassWindows, add: Add, range: Range, withRange: WithRange) {
  const use = stats.filter(settled);
  const w = win.brake_c;
  for (const axle of AXLES) {
    for (const dir of ["low", "high"] as const) {
      const bad = use.filter((s) => outside(wheelsOf(s, "brake_c")[axle], w) === dir);
      if (bad.length < RULES.brakeTempMinLaps) continue;
      const v = mean(bad.map((s) => wheelsOf(s, "brake_c")[axle]));
      const laps = bad.map((s) => s.lap_no);
      add({
        category: "brakes", kind: `brake_${dir}`, severity: sev(bad.length / use.length * 0.6),
        laps, numbers: withRange(laps, { mean: r(v, 0), window_min: w.min, window_max: w.max, n_laps: bad.length }),
        say: (n) => `${axle[0].toUpperCase()}${axle.slice(1)} brake disc temperature averaged ${n.mean.toFixed(0)} °C over ${n.n_laps} ${n.n_laps === 1 ? "lap" : "laps"} (${range(n)}), ${dir === "low" ? "below" : "above"} the ${n.window_min}-${n.window_max} °C window.`,
        locate: true,
      });
    }
  }
  // Discs cool in the pits: an out lap's disc temperature against the flying laps before the stop.
  stats.forEach((s, i) => {
    if (s.kind !== "out" || i === 0) return;
    const before = stats.slice(0, i).filter((x) => x.kind === "flying");
    if (!before.length) return;
    const now = wheelsOf(s, "brake_c");
    const avg = (axle: "front" | "rear") => mean(before.map((x) => wheelsOf(x, "brake_c")[axle]));
    const drop = Math.max(...AXLES.map((a) => 1 - now[a] / avg(a)));
    if (drop < RULES.pitCoolingShare) return;
    add({
      category: "brakes", kind: "brake_pit_cooling", severity: "info", laps: [s.lap_no],
      numbers: withRange([s.lap_no], { front_c: r(now.front, 0), rear_c: r(now.rear, 0), front_before_c: r(avg("front"), 0), rear_before_c: r(avg("rear"), 0) }),
      say: (n) => `Brake discs were cooler on the out lap (${range(n)}): front ${n.front_c.toFixed(0)} °C and rear ${n.rear_c.toFixed(0)} °C, against ${n.front_before_c.toFixed(0)} °C and ${n.rear_before_c.toFixed(0)} °C on the flying laps before the stop.`,
    });
  });
  const ratio = (s: StintLap) => { const b = wheelsOf(s, "brake_c"); return b.rear > 0 ? b.front / b.rear : 1; };
  const rw = win.brake_front_rear_ratio;
  for (const dir of ["low", "high"] as const) {
    const bad = use.filter((s) => outside(ratio(s), rw) === dir);
    if (bad.length < RULES.brakeRatioMinLaps) continue;
    const laps = bad.map((s) => s.lap_no);
    add({
      category: "brakes", kind: `brake_imbalance_${dir}`, severity: sev(bad.length / use.length),
      laps, numbers: withRange(laps, { ratio: r(mean(bad.map(ratio))), window_min: rw.min, window_max: rw.max, n_laps: bad.length }),
      say: (n) => `Front to rear disc temperature ratio averaged ${n.ratio.toFixed(2)} over ${n.n_laps} laps (${range(n)}), ${dir === "low" ? "below" : "above"} the ${n.window_min}-${n.window_max} range.`,
      locate: true,
    });
  }
}

/** Tyre and brake values on the laps outside the session's best laps against the best laps' mean, per axle. Reported only for laps that
 * coincide with time lost against the best lap. */
function vsBestEvents(stats: StintLap[], bestNos: Set<number>, coincidence: (laps: number[]) => ReportCoincidence | null, add: Add, range: Range, withRange: WithRange) {
  const use = stats.filter(settled);
  const best = use.filter((s) => bestNos.has(s.lap_no));
  const others = use.filter((s) => !bestNos.has(s.lap_no));
  if (!best.length || !others.length) return;
  const metrics = [
    ["tyre_surface_c", "tyres", "tyre surface temperature", "°C", 1, RULES.bestTempDiffC], ["tyre_carcass_c", "tyres", "tyre carcass temperature", "°C", 1, RULES.bestTempDiffC],
    ["tyre_pressure_kpa", "tyres", "tyre pressure", "kPa", 0, RULES.bestPressureDiffKpa], ["brake_c", "brakes", "brake disc temperature", "°C", 0, RULES.bestBrakeDiffC],
  ] as const;
  for (const [key, category, label, unit, d, minDiff] of metrics) {
    for (const axle of AXLES) {
      const ref = mean(best.map((s) => wheelsOf(s, key)[axle]));
      for (const dir of ["high", "low"] as const) {
        const hit = others.filter((s) => { const diff = wheelsOf(s, key)[axle] - ref; return dir === "high" ? diff >= minDiff : diff <= -minDiff; });
        if (hit.length < RULES.bestMinLaps) continue;
        const laps = hit.map((s) => s.lap_no);
        if (!coincidence(laps)) continue;
        const diff = Math.abs(mean(hit.map((s) => wheelsOf(s, key)[axle])) - ref);
        add({
          category, kind: `vs_best_${key}_${dir}`, severity: gapSev(diff / (key === "brake_c" ? 100 : key === "tyre_pressure_kpa" ? 20 : 20)),
          laps, numbers: withRange(laps, { diff: r(diff, d), n_laps: hit.length, n_best: best.length }),
          say: (n) => `${axle[0].toUpperCase()}${axle.slice(1)} ${label} ran ${n.diff.toFixed(d)} ${unit} ${key === "tyre_pressure_kpa" ? (dir === "high" ? "higher" : "lower") : dir === "high" ? "hotter" : "colder"} than on your ${n.n_best} best laps, on ${n.n_laps} laps (${range(n)}).`,
          locate: true,
        });
      }
    }
  }
}

/** Metres of a lap's runs inside a corner (inclusive grid metres). */
const overlap = (runs: Run[], c: Corner) => runs.reduce((s, x) => s + Math.max(0, Math.min(x.end, c.end_m) - Math.max(x.start, c.start_m) + 1), 0);

function drivingEvents(
  input: ReportInput, traced: [number, TraceFacts & { aids: AidRuns }][], bestLap: number | null, add: Add, range: Range, withRange: WithRange,
) {
  const timedNo = (n: number) => { const l = input.laps.find((x) => x.lap_no === n); return !!l && isTimed(l); };
  const { corners } = input;
  const n = traced.length;
  const cornerLoss = (lapNos: number[], i: number): ReportCoincidence | null => {
    const best = bestLap === null ? null : input.traces.get(bestLap)?.corner_times_s[i];
    if (best === undefined || best === null) return null;
    const xs = lapNos.filter((l) => l !== bestLap && timedNo(l)).flatMap((l) => { const t = input.traces.get(l)?.corner_times_s[i]; return t === undefined ? [] : [t - best]; });
    if (!xs.length) return null;
    const m = mean(xs);
    return m >= RULES.minCornerLostS ? { scope: "corner", lost_s: r(m), laps: lapNos.filter((l) => l !== bestLap && timedNo(l)) } : null;
  };
  const perCorner = (kind: "lockup" | "wheelspin" | "abs" | "tc") =>
    corners.map((c, i) => ({
      c, i,
      perLap: traced.map(([lap, t]) => ({ lap, m: overlap(t.aids[kind], c), runs: t.aids[kind].filter((x) => x.end >= c.start_m && x.start <= c.end_m).length })),
    }));

  for (const [kind, min, word] of [["lockup", RULES.lockupMinLaps, "locked a wheel under braking"], ["wheelspin", RULES.wheelspinMinLaps, "spun a driven wheel on the throttle"]] as const) {
    for (const { c, i, perLap } of perCorner(kind)) {
      const hit = perLap.filter((x) => x.runs > 0);
      if (hit.length < min) continue;
      const laps = hit.map((x) => x.lap);
      add({
        category: "driving", kind: `${kind}s`, severity: sev(hit.length / n),
        laps, numbers: withRange(laps, { n_laps: hit.length, n_traced: n, runs: hit.reduce((a, x) => a + x.runs, 0) }),
        say: (nn) => `The car ${word} at ${c.name} on ${nn.n_laps} of ${nn.n_traced} traced laps (${nn.runs} times, ${range(nn)}).`,
        corner: c, distance_m: c.apex_m, coincides: cornerLoss(laps, i),
      });
    }
  }
  // Trend per corner: the same runs, first third of the traced flying laps against the last third.
  const flying = traced.filter(([lap]) => input.laps.some((l) => l.lap_no === lap && l.kind === "flying")).sort((a, b) => a[0] - b[0]);
  const third = Math.floor(flying.length / 3);
  if (flying.length >= RULES.cornerTrendMinLaps && third >= 2) {
    for (const [kind, label] of [["lockup", "Lock-ups"], ["wheelspin", "Wheelspin"]] as const) {
      for (const { c, i, perLap } of perCorner(kind)) {
        const byLap = new Map(perLap.map((x) => [x.lap, x.runs]));
        const head = flying.slice(0, third).map(([lap]) => lap), tail = flying.slice(-third).map(([lap]) => lap);
        const count = (ls: number[]) => ls.reduce((a, l) => a + (byLap.get(l) ?? 0), 0);
        const first = count(head), last = count(tail);
        if (Math.max(first, last) < RULES.cornerTrendMinCount || Math.abs(last - first) < RULES.cornerTrendMinChange) continue;
        const rising = last > first;
        const laps = (rising ? tail : head).filter((l) => (byLap.get(l) ?? 0) > 0);
        add({
          category: "driving", kind: `${kind}_trend`, severity: "watch",
          laps, numbers: {
            ...withRange(laps, {}), n_window: third, first_runs: first, last_runs: last,
            first_lap_from: head[0], first_lap_to: head[third - 1], last_lap_from: tail[0], last_lap_to: tail[third - 1],
          },
          say: (nn) => `${label} at ${c.name} ${rising ? "rose" : "fell"} from ${nn.first_runs} in the first ${nn.n_window} flying laps (laps ${nn.first_lap_from} to ${nn.first_lap_to}) to ${nn.last_runs} in the last ${nn.n_window} (laps ${nn.last_lap_from} to ${nn.last_lap_to}).`,
          corner: c, distance_m: c.apex_m, coincides: cornerLoss(laps, i),
        });
      }
    }
  }
  for (const [kind, label, minM] of [["abs", "ABS", RULES.absCornerMinM], ["tc", "Traction control", RULES.tcCornerMinM]] as const) {
    perCorner(kind)
      .map((x) => ({ ...x, avg: mean(x.perLap.map((p) => p.m)) }))
      .filter((x) => x.avg >= minM)
      .sort((a, b) => b.avg - a.avg).slice(0, RULES.maxAidCorners)
      .forEach(({ c, i, perLap, avg }) => {
        const laps = perLap.filter((p) => p.m > 0).map((p) => p.lap);
        add({
          category: "driving", kind: `${kind}_activation`, severity: "info",
          laps, numbers: withRange(laps, { avg_m: r(avg, 0), n_laps: laps.length, n_traced: n }),
          say: (nn) => `${label} was active for ${nn.avg_m.toFixed(0)} m a lap on average at ${c.name} (${nn.n_laps} of ${nn.n_traced} traced laps, ${range(nn)}).`,
          corner: c, distance_m: c.apex_m, coincides: cornerLoss(laps, i),
        });
      });
  }
  // Trend across the session: flying laps only, so pit and out laps do not skew it.
  for (const [key, label] of [["abs_m", "ABS"], ["tc_m", "Traction control"]] as const) {
    const pts = input.laps.filter((l) => l.kind === "flying" && input.aid_activation.has(l.lap_no)).map((l) => [l.lap_no, input.aid_activation.get(l.lap_no)![key]] as const);
    const fit = fitLine([...pts]);
    if (!fit || pts.length < 3) continue;
    const a = pts[0][0], b = pts[pts.length - 1][0];
    const first = fit.intercept + fit.slope * a, last = fit.intercept + fit.slope * b;
    const change = last - first;
    if (Math.abs(change) < RULES.trendMinM || Math.abs(change) < RULES.trendShare * Math.max(first, 1)) continue;
    const laps = pts.map((p) => p[0]);
    add({
      category: "driving", kind: `${key === "abs_m" ? "abs" : "tc"}_trend`, severity: "info", laps,
      numbers: withRange(laps, { first_m: r(first, 0), last_m: r(last, 0) }),
      say: (nn) => `${label} activation per flying lap ${change > 0 ? "rose" : "fell"} from about ${nn.first_m.toFixed(0)} m to ${nn.last_m.toFixed(0)} m across ${range(nn)}.`,
    });
  }
}

/** Raw fall-off of a run of laps, for a session without stint stats: the same rule as lib/stint (flying, valid, not slow). */
function timingFalloff(run: ReportLapInput[]): { slope: number; n: number } | null {
  const clean = run.filter(isTimed);
  if (!clean.length) return null;
  const cut = median(clean.map((l) => l.lap_time_s!)) * SLOW_LAP_FACTOR;
  const fit = fitLine(clean.filter((l) => l.lap_time_s! <= cut).map((l) => [l.lap_no, l.lap_time_s!] as const));
  return fit && { slope: fit.slope, n: fit.n };
}

function paceEvents(input: ReportInput, nTimed: number, add: Add, range: Range, withRange: WithRange) {
  const { laps } = input;
  const falls: { stint: number; laps: number[]; slope: number; raw: number | null; n: number; corrected: boolean }[] = [];
  if (input.stints.length) {
    for (const st of input.stints) {
      const c = st.falloff_fuel_corrected, raw = st.falloff;
      if (!raw) continue;
      falls.push({ stint: st.stint_no, laps: st.laps.map((l) => l.lap_no), slope: c ? c.slope_s_per_lap : raw.slope_s_per_lap, raw: c ? raw.slope_s_per_lap : null, n: raw.n_laps, corrected: !!c });
    }
  } else {
    let run: ReportLapInput[] = [], stint = 1;
    const flush = () => {
      const f = timingFalloff(run);
      if (f) falls.push({ stint, laps: run.map((l) => l.lap_no), slope: f.slope, raw: null, n: f.n, corrected: false });
      run = [];
      stint++;
    };
    for (const l of laps) { run.push(l); if (l.kind === "in") flush(); }
    if (run.length) flush();
  }
  for (const f of falls) {
    if (f.slope <= -RULES.falloffMin) {
      add({
        category: "pace", kind: "pace_improving", severity: "info", laps: f.laps,
        numbers: withRange(f.laps, { stint_no: f.stint, slope_s_per_lap: r(-f.slope), n_laps: f.n }),
        say: (n) => `Lap times in stint ${n.stint_no} got faster by ${n.slope_s_per_lap.toFixed(2)} s a lap over ${n.n_laps} laps${f.corrected ? " with the fuel burnt taken out" : " (no fuel correction)"}.`,
      });
      continue;
    }
    if (f.slope < RULES.falloffMin) continue;
    add({
      category: "pace", kind: "pace_falloff", severity: f.slope >= RULES.falloffProblem ? "problem" : f.slope >= RULES.falloffWatch ? "watch" : "info",
      laps: f.laps,
      numbers: withRange(f.laps, { stint_no: f.stint, slope_s_per_lap: r(f.slope), n_laps: f.n, ...(f.raw !== null ? { raw_slope_s_per_lap: r(f.raw) } : {}) }),
      say: (n) => `Lap times in stint ${n.stint_no} got slower by ${n.slope_s_per_lap.toFixed(2)} s a lap over ${n.n_laps} laps${f.corrected ? ` with the fuel burnt taken out (${n.raw_slope_s_per_lap.toFixed(2)} s a lap before the correction)` : " (no fuel correction)"}.`,
    });
  }
  const pit = laps.filter((l) => l.kind === "out" || l.kind === "in");
  if (pit.length) {
    const nums = withRange(pit.map((l) => l.lap_no), { out_laps: pit.filter((l) => l.kind === "out").length, in_laps: pit.filter((l) => l.kind === "in").length });
    add({
      category: "pace", kind: "pit_laps", severity: "info", laps: pit.map((l) => l.lap_no), coincides: null, numbers: nums,
      say: (n) => `${n.out_laps} out ${n.out_laps === 1 ? "lap" : "laps"} and ${n.in_laps} in ${n.in_laps === 1 ? "lap" : "laps"} (${range(n)}) are left out of the pace.`,
    });
  }
  const invalid = laps.filter((l) => l.kind === "flying" && !l.valid);
  if (invalid.length) {
    add({
      category: "pace", kind: "invalid_laps", severity: invalid.length / Math.max(1, nTimed + invalid.length) > 0.3 ? "watch" : "info",
      laps: invalid.map((l) => l.lap_no), coincides: null,
      numbers: withRange(invalid.map((l) => l.lap_no), { n_laps: invalid.length }),
      say: (n) => `${n.n_laps} flying ${n.n_laps === 1 ? "lap was" : "laps were"} invalid (${range(n)}).`,
    });
  }
}
