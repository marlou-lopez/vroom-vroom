// Which telemetry strips the inputs panel shows and in what order, remembered per browser (vroom-pnw.13).

export const STRIP_OPTIONS = [
  { id: "speed", label: "Speed" },
  { id: "pedals", label: "Throttle · brake" },
  { id: "gear", label: "Gear" },
  { id: "steering", label: "Steering" },
  { id: "delta", label: "Delta" },
  { id: "elevation", label: "Elevation (if the track has it)" },
  { id: "rpm", label: "RPM" },
  { id: "g_lat", label: "Lateral g" },
  { id: "g_long", label: "Longitudinal g" },
  { id: "suspension", label: "Suspension" },
  { id: "slip", label: "Tyre slip" },
  /** Only offered with `?balance` (experimental, vroom-pnw.15). */
  { id: "balance", label: "Balance (experimental)" },
] as const;

export type StripId = (typeof STRIP_OPTIONS)[number]["id"];

export const STRIP_IDS: readonly StripId[] = STRIP_OPTIONS.map((o) => o.id);

/** Today's strips, in today's order. */
export const DEFAULT_STRIPS: readonly StripId[] = ["speed", "pedals", "gear", "steering", "delta", "elevation"];

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
