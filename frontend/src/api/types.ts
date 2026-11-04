// TypeScript mirrors of the backend request/response models (Tasks 2, 5, 7, 9-13, 16).
// Field names are snake_case, exactly as in the Python models. Datetimes are ISO-8601 strings.

export const GRID_CHANNELS = [
  "t", "speed_kmh", "throttle", "brake", "steering", "gear", "rpm", "g_lat", "g_long", "yaw_rate",
  "lat", "lon", "path_lateral", "track_edge", "kerb", "susp_fl", "susp_fr", "susp_rl", "susp_rr",
] as const;
export type GridChannel = (typeof GRID_CHANNELS)[number];

/** Every grid channel, one value per metre. `steering` is normalised (-1..1); degrees = steering * range / 2. */
export type ChannelArrays = Record<GridChannel, number[]>;

// ---- Sessions and laps (model.py) ----

export type LapKind = "flying" | "out" | "in" | "incomplete";
export type LapSource = "own_recording" | "imported_file" | "online";

export interface SessionMeta {
  session_id: string;
  track_name: string;
  track_layout: string;
  track_id: string;
  track_length_m: number;
  car_name: string;
  car_id: string;
  car_class: string;
  session_type: string;
  game_build: string;
  started_at: string;
  driver: string;
  /** null when neither the recording nor config/cars.yaml knows it: show steering as a percentage. */
  steering_range_deg: number | null;
}

export interface LapMeta {
  lap_id: string;
  session_id: string;
  lap_no: number;
  kind: LapKind;
  lap_time_s: number | null;
  sectors_s: number[];
  valid: boolean;
  /** Manual override; wins over `valid` (effective validity = valid_override ?? valid). */
  valid_override: boolean | null;
  pinned_reference: boolean;
  source: LapSource;
  driver: string;
  track_id: string;
  car_id: string;
  conditions: Record<string, number>;
}

/** GET /api/sessions/{id}/laps rows: LapMeta plus whether this lap is the reference for its track and car. */
export type LapWithRef = LapMeta & { is_reference: boolean };

export function effectiveValid(lap: Pick<LapMeta, "valid" | "valid_override">): boolean {
  return lap.valid_override ?? lap.valid;
}

export interface LapPatch {
  valid_override?: boolean | null;
  pinned_reference?: boolean;
}

export interface TraceResponse {
  distance: number[];
  ch: Partial<Record<GridChannel, number[]>>;
}

// ---- Compare ----

export interface CompareResponse {
  /** Not in the plan's route table: the ids actually compared (needed when `ref` was omitted). */
  lap_id: string;
  ref_lap_id: string;
  /** Kinds of `lap_id` and `ref_lap_id`; the view uses them to build the centreline from flying laps only. */
  lap_kind: LapKind;
  ref_kind: LapKind;
  distance: number[];
  lap: ChannelArrays;
  ref: ChannelArrays;
  /** lap.t - ref.t at each grid point; positive means the lap is behind. */
  delta: number[];
  warning: string | null;
  lap_steering_range_deg: number | null;
  ref_steering_range_deg: number | null;
}

export interface CompareCandidate {
  lap_id: string;
  label: string;
  lap_time_s: number | null;
  car_name: string;
  is_reference: boolean;
  is_previous: boolean;
  other_car: boolean;
}

// ---- Tracks (tracks.py) ----

export interface Corner {
  id: string;
  name: string;
  start_m: number;
  apex_m: number;
  end_m: number;
  complex: string | null;
  approx: boolean;
}

export type LandmarkKind = "brake_board" | "kerb_entry" | "kerb_apex" | "kerb_exit" | "custom";
export type LandmarkConfidence = "low" | "detected" | "confirmed";

export interface Landmark {
  id: string;
  label: string;
  kind: LandmarkKind;
  distance_m: number;
  corner_id: string | null;
  confidence: LandmarkConfidence;
}

export interface LandmarkPatch {
  confirm?: boolean;
  distance_m?: number;
}

export interface TrackMap {
  track_id: string;
  length_m: number;
  corners: Corner[];
  landmarks: Landmark[];
}

export interface DetectedCorner {
  apex_m: number;
  start_m: number;
  end_m: number;
  min_speed_kmh: number;
  flat: boolean;
}

export interface CalibrationResult {
  map: TrackMap;
  unmapped: DetectedCorner[];
  missing: string[];
}

// ---- Coach (coach/schema.py) ----

export type Command = "analyze" | "average" | "corner";
export type FindingKind = "issue" | "minor" | "strength" | "inconsistent";
export type CueType = "landmark" | "feel" | "own_lap" | "none";

export interface CoachRequest {
  command: Command;
  lap_id: string;
  ref_lap_id: string | null;
  corner_id: string | null;
}

export interface Finding {
  id: string;
  corner_id: string;
  corner: string;
  kind: FindingKind;
  /** The corner's delta_s (or sd_s for `inconsistent`), to 3 decimals. */
  time_s: number;
  what: string;
  fix: string;
  cue_type: CueType;
  evidence: string[];
  reviewed: boolean;
}

export interface Focus {
  corner_id: string;
  instruction: string;
  metric: string;
}

export interface CoachResult {
  id: string;
  command: Command;
  lap_id: string;
  ref_lap_id: string | null;
  summary: string;
  findings: Finding[];
  focus: Focus | null;
  encouragement: string | null;
  stats: Record<string, string>;
  warnings: string[];
  cost_usd: number | null;
  created_at: string;
}

/** The latest result of each command for a (lap, ref) pair. */
export type CoachResults = Partial<Record<Command, CoachResult>>;

// ---- Sessions screen, import, usage ----

export interface SessionSummary {
  n_laps: number;
  n_valid: number;
  best_lap_s: number | null;
  theoretical_best_s: number | null;
  track_temp_c: number | null;
  focus: { instruction: string; improved: boolean | null } | null;
}

export interface ImportResult {
  session_id: string;
  n_laps: number;
  skipped: boolean;
}

export interface LlmCall {
  command: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number | null;
  ok: boolean;
  created_at: string;
}

export interface LlmUsage {
  calls: LlmCall[];
  total_usd: number;
}

// ---- Errors ----

export type ApiErrorCode =
  | "not_enough_laps" | "no_reference" | "track_mismatch" | "missing_api_key" | "llm_error"
  | "invalid_output" | "unknown_corner"
  | "unknown_lap" | "unknown_session" | "unknown_track" | "unknown_landmark" | "unknown_finding"
  | "network" | (string & {});

/** Thrown by every Api method on failure. Mirrors the backend's `{code, message}` error body. */
export class ApiError extends Error {
  code: ApiErrorCode;
  constructor(code: ApiErrorCode, message: string = code) {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}

/** `{code, message}` for any thrown value, for showing an error inline. */
export function errorInfo(e: unknown): { code: string; message: string } {
  const x = e as Partial<ApiError>;
  return { code: x.code ?? "error", message: x.message ?? String(e) };
}
