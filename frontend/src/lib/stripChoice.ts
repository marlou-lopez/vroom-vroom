// Which telemetry strips the inputs panel shows and in what order, remembered per browser (vroom-pnw.13).

export type StripGroup = "basics" | "advanced";

export const STRIP_OPTIONS = [
  { id: "delta", label: "Time vs best", group: "basics", desc: "Where you gain or lose time on the comparison lap. Rising = losing." },
  { id: "speed", label: "Speed", group: "basics", desc: "How fast you are at every point of the lap." },
  { id: "pedals", label: "Brake & throttle", group: "basics", desc: "When you brake and get back on the power." },
  { id: "steering", label: "Steering", group: "basics", desc: "How much and how early you turn the wheel." },
  { id: "gear", label: "Gear", group: "advanced", desc: "Which gear you are in, with the shifts." },
  { id: "elevation", label: "Elevation (if the track has it)", group: "advanced", desc: "Hills and crests along the lap." },
  { id: "rpm", label: "RPM", group: "advanced", desc: "Engine speed, to see shift points." },
  { id: "g_lat", label: "Lateral g", group: "advanced", desc: "Cornering force: how hard the car is turning." },
  { id: "g_long", label: "Longitudinal g", group: "advanced", desc: "Braking and acceleration force." },
  { id: "suspension", label: "Suspension", group: "advanced", desc: "How far the suspension is compressed." },
  { id: "slip", label: "Tyre slip", group: "advanced", desc: "How much the tyres are sliding." },
  /** Offered when the lap has a balance (API `lap_balance`, vroom-bi4.6). */
  { id: "balance", label: "Balance (understeer, exp)", group: "advanced", desc: "Understeer through the corners (experimental)." },
] as const;

export type StripId = (typeof STRIP_OPTIONS)[number]["id"];

export const STRIP_IDS: readonly StripId[] = STRIP_OPTIONS.map((o) => o.id);

/** Three strips for a first visit: the answer to "where am I slow" on top (vroom-pnw.57). */
export const DEFAULT_STRIPS: readonly StripId[] = ["delta", "speed", "pedals"];

export const STRIPS_KEY = "vroom.strips";

const isId = (v: unknown): v is StripId => typeof v === "string" && (STRIP_IDS as readonly string[]).includes(v);

/** A stored choice: a non-empty list of distinct known ids. Anything else (unknown channel, bad JSON, empty) gives the default set. */
export function parseStrips(raw: string | null | undefined): StripId[] {
  try {
    const v: unknown = JSON.parse(raw ?? "null");
    if (Array.isArray(v) && v.length > 0 && v.every(isId) && new Set(v).size === v.length) return v;
  } catch { /* fall through */ }
  return [...DEFAULT_STRIPS];
}

function defaultStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

export function loadStrips(storage: Pick<Storage, "getItem"> | null = defaultStorage()): StripId[] {
  try { return parseStrips(storage?.getItem(STRIPS_KEY)); } catch { return [...DEFAULT_STRIPS]; }
}

export function saveStrips(ids: readonly StripId[], storage: Pick<Storage, "setItem"> | null = defaultStorage()): void {
  try { storage?.setItem(STRIPS_KEY, JSON.stringify(ids)); } catch { /* private mode or full: the choice just isn't remembered */ }
}

/** Add `id` at the end, or remove it (never the last one: the panel always shows a strip). */
export function toggleStrip(ids: readonly StripId[], id: StripId): StripId[] {
  if (!ids.includes(id)) return [...ids, id];
  return ids.length > 1 ? ids.filter((x) => x !== id) : [...ids];
}

/** Move `id` one place up (-1) or down (+1); a no-op at either end. */
export function moveStrip(ids: readonly StripId[], id: StripId, dir: -1 | 1): StripId[] {
  const i = ids.indexOf(id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= ids.length) return [...ids];
  const out = [...ids];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}
