/**
 * The conversion settings and the list of parts to drop, in ONE place (#102). Used by the in-browser converter (a Web Worker)
 * and by `tools/optimize-car-model.mjs`, so the two cannot drift. No imports: Node runs this file directly.
 */

/** Node-name patterns to drop (Assetto Corsa / ACC naming). Matched against the name without Sketchfab's trailing _<n>. */
export const DROP_PATTERNS: readonly RegExp[] = [
  /^DAMAGE_GLASS/i, /^RIM_BLUR/i, /^CINTURE/i, /^DISPLAY_DATA/i, /^LUMIRANK/i, /^WIPER/i, /^DISC_/i, /^SUSP_/i,
  /^DOOR_INT/i, /^INT_Window/i, /^racelogic/i,
];
/** The high-res cockpit and steering wheel: dropped unless `keepCockpit`. */
export const COCKPIT_PATTERNS: readonly RegExp[] = [/^COCKPIT_HR/i, /^STEER_HR/i];
/** Kept by name for #101 (steering wheel, RPM and slip LEDs). Group 1 becomes the name of the mesh nodes below it; everything else is anonymised so `join` can merge it. */
export const NAMED_PATTERN = /^(STEER_LR|RPM_LED_\d+|Slip_(?:Left|Right)_\d+)/i;

export interface ConvertOptions {
  /** Share of vertices simplification aims to keep. */
  ratio: number;
  /** Simplification error tolerance, as a fraction of the mesh extent. */
  error: number;
  lockBorder: boolean;
  /** Largest texture side in pixels (larger ones are scaled down). */
  texSize: number;
  /** WebP quality, 0 to 1. */
  webpQuality: number;
  meshoptLevel: "medium" | "high";
  /** GPU instancing is used for meshes that occur at least this often. */
  instanceMin: number;
  /** Keep the high-res cockpit and steering wheel. */
  keepCockpit: boolean;
  /** Skip flatten and join: the RPM and slip LEDs and the steering wheel stay as separate named nodes (#101). */
  keepGraph: boolean;
}

export const DEFAULT_OPTIONS: Readonly<ConvertOptions> = {
  ratio: 0.3, error: 0.001, lockBorder: true, texSize: 1024, webpQuality: 0.8, meshoptLevel: "high", instanceMin: 5,
  keepCockpit: false, keepGraph: false,
};

export function withDefaults(o: Partial<ConvertOptions> = {}): ConvertOptions {
  return { ...DEFAULT_OPTIONS, ...o };
}

/** Sketchfab appends _<n> to repeated names. */
export const baseName = (n: string): string => n.replace(/_\d+$/, "");

export function dropPatterns(o: Pick<ConvertOptions, "keepCockpit">): RegExp[] {
  return o.keepCockpit ? [...DROP_PATTERNS] : [...DROP_PATTERNS, ...COCKPIT_PATTERNS];
}

export const isDropped = (name: string, o: Pick<ConvertOptions, "keepCockpit">): boolean => dropPatterns(o).some((re) => re.test(baseName(name)));

/** The kept name (STEER_LR, RPM_LED_3...) a node name stands for, or "". */
export const namedPart = (name: string): string => NAMED_PATTERN.exec(baseName(name))?.[1] ?? "";

/** Stage ids in the order the pipeline reports them. */
export const STAGES = ["reading", "cleaning", "simplifying", "textures", "compressing", "saving"] as const;
export type Stage = (typeof STAGES)[number];
