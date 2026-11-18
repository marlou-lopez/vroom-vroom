// EXPERIMENTAL (spike vroom-k5s.2, docs/session-report/suggestions.md): read-only setup and driver-aid suggestions from the session report.
// Pure: built from what the Api already serves (the report, the garage setup, the stint stats), no contract change. Like the report, every
// sentence states facts computed here and every number in it is in `numbers`. At most `MAX_SUGGESTIONS` changes are shown; everything else
// the rules looked at goes in `considered` with the reason nothing is suggested, so "no change" is an answer too.
import type { CarSetup, ReportLap, ReportWindow, SessionReport, SettingName, Stint, StintLap } from "../api/types";

export type SuggestionConfidence = "high" | "medium" | "low";
export type SuggestionArea = "tyres" | "brakes" | "aids";

export interface Suggestion {
  id: string;
  area: SuggestionArea;
  /** `change`: a garage change; `experiment`: try it for a run and compare, because the data cannot say which way is better. */
  kind: "change" | "experiment";
  /** LMU setup keys the suggestion is about. */
  keys: string[];
  /** The garage value at the start of the session (CarSetup is the start setup), or null when the session has no setup. */
  current: string | null;
  /** Short imperative: "Lower front cold pressure by about 3 kPa". */
  title: string;
  /** The corner the reason names (its name may hold digits that are not facts), or null. */
  corner: string | null;
  /** Why, as facts: every number is in `numbers` (the title's too). */
  reason: string;
  numbers: Record<string, number>;
  confidence: SuggestionConfidence;
  /** Why the confidence is what it is. */
  caveat: string;
  /** What to look at in the next session to tell whether it worked. */
  verify: string;
}

export interface Considered {
  area: SuggestionArea;
  keys: string[];
  label: string;
  /** Why no change is suggested (in range, not enough data, or not supported). */
  reason: string;
  numbers: Record<string, number>;
}

export interface SuggestionSet {
  suggestions: Suggestion[];
  /**
   * Out-of-range findings whose target is not trusted yet (decision of 2026-11-19, option 2 in the write-up): pressure, brake ducts and
   * camber. Their windows are measured from the driver's own laps or are folklore, so they are shown as observations, not as changes.
   */
  observations: Suggestion[];
  /** Suggestions beyond the first `MAX_SUGGESTIONS`, kept so the panel can say they exist. */
  more: Suggestion[];
  considered: Considered[];
}

export const MAX_SUGGESTIONS = 2;

/** Rules whose out-of-range result is an observation, not a suggested change (see `SuggestionSet.observations`). */
const OBSERVE_ONLY = /^(pressure|ducts|camber)-/;

/** Thresholds: first guesses, like the report's RULES. */
export const SUGGEST = {
  /** Timed laps needed before a temperature or pressure is judged. */
  minLaps: 3,
  /** Atmospheric pressure (kPa) for the gas-law cold to hot step. */
  atmKpa: 101.3,
  /**
   * Inner minus outer tread temperature band (°C) where camber is left alone. Community rule of thumb only (7-12 °C, no LMU source;
   * LMU's own guide just asks for "even" temperatures), hence low confidence.
   */
  camberBandC: { min: 7, max: 12 },
  /**
   * An aid experiment needs the corner's time lost to be at least this (s). The report reports from 0.03 s, but at that level an
   * experiment fired on 5 of 8 mock sessions (0.04-0.05 s at one corner), which is noise, not a lead.
   */
  aidMinLostS: 0.1,
  /** An in-car setting must have stayed off its garage value for this many laps at the end of the session. */
  keptMinLaps: 2,
} as const;

const AXLES = ["front", "rear"] as const;
type Axle = (typeof AXLES)[number];
const r = (v: number, d = 1) => Math.round(v * 10 ** d) / 10 ** d;
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const isTimed = (l: { kind: string; valid: boolean; lap_time_s: number | null }) => l.kind === "flying" && l.valid && (l.lap_time_s ?? 0) > 0;
const AXLE_WORD: Record<Axle, string> = { front: "Front", rear: "Rear" };
const WHEEL_KEYS: Record<Axle, [string, string]> = { front: ["FL", "FR"], rear: ["RL", "RR"] };

const SETTING_KEY: Partial<Record<SettingName, string>> = {
  ABSLevel: "VM_ANTILOCKBRAKESYSTEMMAP", TCLevel: "VM_TRACTIONCONTROLMAP", TCCut: "VM_TRACTIONCONTROLPOWERCUTMAP", TCSlipAngle: "VM_TRACTIONCONTROLSLIPANGLEMAP",
};
const SETTING_WORD: Record<SettingName, string> = { ABSLevel: "ABS", TCLevel: "TC", TCCut: "TC power cut", TCSlipAngle: "TC slip", FuelMixtureMap: "Engine map" };

function setupValue(setup: CarSetup | null, key: string): string | null {
  return setup?.entries.find((e) => e.key === key)?.value ?? null;
}
/** "136 kPa" -> 136; "6 (Balanced)" -> 6; "Open" -> null. */
const leadingNumber = (v: string | null): number | null => {
  const m = v === null ? null : /^\s*(-?\d+(\.\d+)?)/.exec(v);
  return m ? Number(m[1]) : null;
};
/** Both wheels' values, or one value when they are the same. */
function axleSetup(setup: CarSetup | null, item: string, axle: Axle): { keys: string[]; current: string | null } {
  const keys = WHEEL_KEYS[axle].map((w) => `WM_${item}-W_${w}`);
  const vals = keys.map((k) => setupValue(setup, k));
  if (vals.some((v) => v === null)) return { keys, current: null };
  return { keys, current: vals[0] === vals[1] ? vals[0] : `${vals[0]} / ${vals[1]}` };
}
const windowFor = (ws: ReportWindow[], key: string, axle: Axle) => ws.find((w) => w.key === key && (w.axle === axle || w.axle === "both")) ?? null;
/** The report's windows are partly measured from the driver's own laps (reportWindows.ts): "in the window" then means "like your usual laps". */
const selfMeasured = (w: ReportWindow) => w.source.startsWith("Measured");

function axleMean(laps: ReportLap[], pick: (l: ReportLap) => { front: number; rear: number } | null, axle: Axle): { value: number; n: number } | null {
  const xs = laps.map(pick).filter((x): x is { front: number; rear: number } => x !== null).map((x) => x[axle]);
  return xs.length >= SUGGEST.minLaps ? { value: mean(xs), n: xs.length } : null;
}

// ---- Rules ----

function pressureRule(report: SessionReport, setup: CarSetup | null, timed: ReportLap[], out: Out) {
  for (const axle of AXLES) {
    const w = windowFor(report.windows, "tyre_pressure_kpa", axle);
    const m = axleMean(timed, (l) => l.tyre_pressure_kpa, axle);
    const { keys, current } = axleSetup(setup, "PRESSURE", axle);
    const label = `${AXLE_WORD[axle]} tyre pressure`;
    if (!w || !m) { out.considered.push({ area: "tyres", keys, label, reason: `Not judged: needs a pressure window and ${SUGGEST.minLaps} timed laps with tyre stats.`, numbers: { min_laps: SUGGEST.minLaps } }); continue; }
    const hot = r(m.value), gapHigh = m.value - w.max, gapLow = w.min - m.value;
    if (gapHigh <= w.tolerance && gapLow <= w.tolerance) {
      out.considered.push({
        area: "tyres", keys, label, numbers: { hot, min: w.min, max: w.max, n_laps: m.n },
        reason: `Hot pressure averaged ${hot.toFixed(1)} kPa over ${m.n} timed laps, inside the ${w.min}-${w.max} kPa window.${selfMeasured(w) ? " The window is measured from your own best laps, so this means 'like your usual laps', not 'correct'." : ""}`,
      });
      continue;
    }
    // Cold to hot at constant volume (ideal gas): (hot + atm) / (cold + atm) = T_hot / T_cold, so 1 kPa cold is `ratio` kPa hot.
    // The ratio comes from this session's own cold setting and hot mean; without a cold value, the hot gap is used as is.
    const target = (w.min + w.max) / 2, hotGap = m.value - target;
    const cold = leadingNumber(current);
    const ratio = cold !== null ? (m.value + SUGGEST.atmKpa) / (cold + SUGGEST.atmKpa) : 1;
    const step = Math.max(1, Math.round(Math.abs(hotGap) / ratio));
    const down = hotGap > 0;
    const numbers: Record<string, number> = { hot, min: w.min, max: w.max, n_laps: m.n, step };
    if (cold !== null) numbers.ratio = r(ratio, 2);
    out.suggestions.push({
      id: `pressure-${axle}`, area: "tyres", kind: "change", keys, current, corner: null,
      title: `${down ? "Lower" : "Raise"} ${axle} cold pressure by about ${step} kPa`,
      reason: `${AXLE_WORD[axle]} hot pressure averaged ${hot.toFixed(1)} kPa over ${m.n} timed laps, ${down ? "above" : "below"} the ${w.min}-${w.max} kPa window. ` +
        (cold !== null ? `At this session's temperatures 1 kPa cold is about ${r(ratio, 2).toFixed(2)} kPa hot, so about ${step} kPa cold moves it to the middle of the window.`
          : `The session has no recorded setup, so ${step} kPa is the hot gap to the window's middle.`),
      numbers, confidence: selfMeasured(w) ? "medium" : "low",
      caveat: `${selfMeasured(w) ? "The window is measured from your own best laps, not a published target." : "The window is an assumption, not a published target."} The cold-to-hot step uses the gas law, not an LMU figure.`,
      verify: `${AXLE_WORD[axle]} hot pressure on the timed laps of the next session lands inside ${w.min}-${w.max} kPa.`,
    });
  }
}

function ductRule(report: SessionReport, setup: CarSetup | null, timed: ReportLap[], out: Out) {
  for (const axle of AXLES) {
    const key = axle === "front" ? "VM_BRAKE_DUCTS" : "VM_BRAKE_DUCTS_REAR";
    const current = setupValue(setup, key);
    const label = `${AXLE_WORD[axle]} brake ducts`;
    const w = windowFor(report.windows, "brake_c", axle);
    const m = axleMean(timed, (l) => l.brake_c, axle);
    if (!w || !m) { out.considered.push({ area: "brakes", keys: [key], label, reason: `Not judged: needs a brake window and ${SUGGEST.minLaps} timed laps with brake stats.`, numbers: { min_laps: SUGGEST.minLaps } }); continue; }
    const disc = Math.round(m.value), hot = m.value - w.max > w.tolerance, cold = w.min - m.value > w.tolerance;
    const numbers = { disc, min: w.min, max: w.max, n_laps: m.n };
    if (!hot && !cold) {
      out.considered.push({ area: "brakes", keys: [key], label, numbers, reason: `Discs averaged ${disc} °C over ${m.n} timed laps, inside the ${w.min}-${w.max} °C window.${selfMeasured(w) ? " The window is measured from your own best laps." : ""}` });
      continue;
    }
    // LMU shows ducts as words ("Open") or steps; "Open" is taken to be the most open setting (unverified).
    if (hot && current !== null && /^open$/i.test(current.trim())) {
      out.considered.push({ area: "brakes", keys: [key], label, numbers, reason: `Discs averaged ${disc} °C over ${m.n} timed laps, above the ${w.min}-${w.max} °C window, but the ducts are already ${current}.` });
      continue;
    }
    out.suggestions.push({
      id: `ducts-${axle}`, area: "brakes", kind: "change", keys: [key], current, corner: null,
      title: `${hot ? "Open" : "Close"} the ${axle} brake ducts one step`,
      reason: `${AXLE_WORD[axle]} discs averaged ${disc} °C over ${m.n} timed laps, ${hot ? "above" : "below"} the ${w.min}-${w.max} °C window.`,
      numbers, confidence: selfMeasured(w) ? "medium" : "low",
      caveat: `LMU does not publish how many degrees a duct step is worth${selfMeasured(w) ? ", and the window is measured from your own best laps" : ", and the window is an assumption"}. Closed ducts can also warm the tyres a little.`,
      verify: `${AXLE_WORD[axle]} disc temperature on the timed laps of the next session lands inside ${w.min}-${w.max} °C.`,
    });
  }
}

/** Tread zones are in the car frame (docs/lmu-duckdb-schema.md): the inner edge is the right zone on the left wheels and the left zone on the right wheels. */
export function innerMinusOuter(l: StintLap, axle: Axle): number {
  const z = l.tyre_zones_c;
  return axle === "front"
    ? ((z.right.fl - z.left.fl) + (z.left.fr - z.right.fr)) / 2
    : ((z.right.rl - z.left.rl) + (z.left.rr - z.right.rr)) / 2;
}

function camberRule(setup: CarSetup | null, stints: Stint[], out: Out) {
  const laps = stints.flatMap((s) => s.laps).filter(isTimed);
  const band = SUGGEST.camberBandC;
  for (const axle of AXLES) {
    const { keys, current } = axleSetup(setup, "CAMBER", axle);
    const label = `${AXLE_WORD[axle]} camber`;
    if (laps.length < SUGGEST.minLaps) { out.considered.push({ area: "tyres", keys, label, reason: `Not judged: needs ${SUGGEST.minLaps} timed laps with tread zone temperatures.`, numbers: { min_laps: SUGGEST.minLaps } }); continue; }
    const spread = r(mean(laps.map((l) => innerMinusOuter(l, axle))));
    const numbers = { spread, min: band.min, max: band.max, n_laps: laps.length };
    if (spread >= band.min && spread <= band.max) {
      out.considered.push({ area: "tyres", keys, label, numbers, reason: `The inner tread edge ran ${spread.toFixed(1)} °C hotter than the outer over ${laps.length} timed laps, inside the ${band.min}-${band.max} °C rule of thumb.` });
      continue;
    }
    const more = spread < band.min;
    out.suggestions.push({
      id: `camber-${axle}`, area: "tyres", kind: "change", keys, current, corner: null,
      title: `${more ? "More" : "Less"} negative ${axle} camber, one step`,
      reason: `The inner tread edge ran ${spread.toFixed(1)} °C ${spread >= 0 ? "hotter" : "cooler"} than the outer over ${laps.length} timed laps, ${more ? "below" : "above"} the ${band.min}-${band.max} °C rule of thumb.`,
      numbers, confidence: "low",
      caveat: "The band is a general rule of thumb, not an LMU figure; LMU gives no load or grip channel to check the contact patch. More negative camber also wears the inner edge faster.",
      verify: `The ${axle} inner-minus-outer spread on the next session's timed laps moves towards ${band.min}-${band.max} °C, and lap times do not get worse.`,
    });
  }
}

function aidRule(report: SessionReport, setup: CarSetup | null, out: Out) {
  const candidates: { setting: "ABSLevel" | "TCLevel"; word: string; key: string; e: SessionReport["events"][number] }[] = [];
  for (const [kind, setting, word] of [["abs_activation", "ABSLevel", "ABS"], ["tc_activation", "TCLevel", "TC"]] as const) {
    const key = SETTING_KEY[setting]!;
    const label = `${word} level`;
    if (setting === "ABSLevel" && setup && setup.entries.length > 0 && !/available/i.test(setupValue(setup, "VM_ANTILOCK_BRAKES") ?? "")) {
      out.considered.push({ area: "aids", keys: [key], label, reason: "This car has no adjustable ABS.", numbers: {} });
      continue;
    }
    const events = report.events.filter((e) => e.kind === kind && e.coincides?.scope === "corner" && e.coincides.lost_s >= SUGGEST.aidMinLostS && e.corner);
    if (events.length === 0) {
      out.considered.push({ area: "aids", keys: [key], label, reason: `No corner where ${word} activation coincides with ${SUGGEST.aidMinLostS.toFixed(2)} s or more lost.`, numbers: { min_lost_s: SUGGEST.aidMinLostS } });
      continue;
    }
    candidates.push({ setting, word, key, e: events.reduce((a, b) => (b.coincides!.lost_s > a.coincides!.lost_s ? b : a)) });
  }
  if (candidates.length === 0) return;
  // One aid test per session: ABS and TC often coincide with the same loss in the same corner, and changing both hides which one mattered.
  // The larger loss goes first, then the aid active for more metres.
  candidates.sort((a, b) => b.e.coincides!.lost_s - a.e.coincides!.lost_s || b.e.numbers.avg_m - a.e.numbers.avg_m);
  const [pick, ...rest] = candidates;
  for (const c of rest) {
    out.considered.push({ area: "aids", keys: [c.key], label: `${c.word} level`, numbers: {}, reason: `Not now: one aid test at a time, and ${pick.word} comes first. Try ${c.word} in a later run.` });
  }
  const { setting, word, key, e } = pick;
  const garage = setupValue(setup, key);
  // The level in use at the end of the session: the last lap's in-car value, else the garage value.
  const last = [...report.laps].reverse().find((l) => l.settings?.[setting] !== undefined)?.settings?.[setting];
  const level = last ?? leadingNumber(garage);
  const corner = e.corner!.name, lost = e.coincides!.lost_s, avg = e.numbers.avg_m;
  const numbers: Record<string, number> = { avg_m: avg, lost_s: lost, n_laps: e.numbers.n_laps };
  if (level !== null) { numbers.level = level; numbers.try = level - 1; }
  out.suggestions.push({
    id: `aid-${setting}`, area: "aids", kind: "experiment", keys: [key], current: garage, corner,
    title: level !== null ? `Try ${word} ${level - 1} instead of ${level} for one run` : `Try ${word} one step lower for one run`,
    reason: `${word} was active for ${avg} m a lap at ${corner} on ${e.numbers.n_laps} laps, which coincides with ${lost.toFixed(2)} s lost there. Whether less ${word} is faster cannot be read from this session: it is a test, not a fix.`,
    numbers, confidence: "low",
    caveat: setting === "TCLevel"
      ? "The recording says when TC acts, not how hard: TC level and TC power cut cannot be told apart, so change the level only. Co-occurrence is not cause."
      : "Lower ABS lets the wheels slip more before it acts: more rotation, more risk of a lock-up. Co-occurrence is not cause.",
    verify: `Compare ${corner}'s corner time and ${word} metres a lap between the two runs (the Corners table and this report).`,
  });
}

/** An in-car setting that stayed off the garage value for the end of the session: putting it in the garage saves the clicks. */
function keptSettingRule(report: SessionReport, setup: CarSetup | null, out: Out) {
  if (!setup || setup.entries.length === 0) return;
  const withSettings = report.laps.filter((l) => l.settings !== null);
  if (withSettings.length < SUGGEST.keptMinLaps) return;
  const tail = withSettings.slice(-SUGGEST.keptMinLaps);
  for (const setting of Object.keys(SETTING_KEY) as SettingName[]) {
    const key = SETTING_KEY[setting]!;
    const garage = leadingNumber(setupValue(setup, key));
    const vals = tail.map((l) => l.settings?.[setting]);
    if (garage === null || vals.some((v) => v === undefined)) continue;
    const end = vals[vals.length - 1]!;
    const changed = report.events.some((e) => e.kind === "setting_changed") && withSettings.some((l) => l.settings?.[setting] !== undefined && l.settings[setting] !== garage);
    if (vals.every((v) => v === end) && end !== garage) {
      out.suggestions.push({
        id: `kept-${setting}`, area: "aids", kind: "change", keys: [key], current: setupValue(setup, key), corner: null,
        title: `Set ${SETTING_WORD[setting]} ${end} in the garage`,
        reason: `You drove the last ${tail.length} laps with ${SETTING_WORD[setting]} ${end}, changed in the car from the garage's ${garage}.`,
        numbers: { end, garage, n_laps: tail.length }, confidence: "high",
        caveat: "This only saves the in-car clicks; it says nothing about whether the value is faster.",
        verify: `The next session starts on ${SETTING_WORD[setting]} ${end}.`,
      });
    } else if (changed) {
      out.considered.push({ area: "aids", keys: [key], label: SETTING_WORD[setting], numbers: { garage }, reason: `Changed in the car during the session but back on the garage's ${garage} at the end.` });
    }
  }
}

function biasNote(setup: CarSetup | null, out: Out) {
  out.considered.push({
    area: "brakes", keys: ["VM_BRAKE_BALANCE"], label: `Brake balance${setupValue(setup, "VM_BRAKE_BALANCE") ? ` (${setupValue(setup, "VM_BRAKE_BALANCE")})` : ""}`, numbers: {},
    reason: "Not supported yet: the report's lock-ups are not split by axle, and in-car bias changes (recorded as 'Brake Bias Rear' events) are not extracted yet.",
  });
}

interface Out { suggestions: Suggestion[]; considered: Considered[] }

const RANK: Record<SuggestionConfidence, number> = { high: 0, medium: 1, low: 2 };

export function buildSuggestions(report: SessionReport, setup: CarSetup | null, stints: Stint[]): SuggestionSet {
  const out: Out = { suggestions: [], considered: [] };
  const timed = report.laps.filter(isTimed);
  keptSettingRule(report, setup, out);
  pressureRule(report, setup, timed, out);
  ductRule(report, setup, timed, out);
  camberRule(setup, stints, out);
  aidRule(report, setup, out);
  biasNote(setup, out);
  // Changes before experiments, then by confidence; the sort is stable, so rule order breaks ties.
  const observations = out.suggestions.filter((s) => OBSERVE_ONLY.test(s.id));
  const ranked = out.suggestions.filter((s) => !OBSERVE_ONLY.test(s.id)).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "change" ? -1 : 1) || RANK[a.confidence] - RANK[b.confidence]);
  return { suggestions: ranked.slice(0, MAX_SUGGESTIONS), more: ranked.slice(MAX_SUGGESTIONS), observations, considered: out.considered };
}

/** `?suggest` (or `?suggest=1`) shows the experimental suggestions panel on the Session tab. Anything else leaves it off. */
export function suggestEnabled(search: string): boolean {
  const v = new URLSearchParams(search).get("suggest");
  return v !== null && v !== "0" && v !== "false";
}
