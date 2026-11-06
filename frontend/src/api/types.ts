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

/**
 * Car size in metres, for drawing it true to size (detailed 2D map, 3D view, cockpit eye).
 * `wheelbase_m` is optional (axle-relative placement, the logger's axle prior). `visual_offset` is where the car's visual centre
 * is relative to the recorded position (LMU's `mPhysicsToGraphicsOffset`, a per-car constant): `forward_m` positive = ahead of
 * the recorded point, `up_m` positive = above it. Absent or null = the recorded point is the visual centre.
 */
export interface CarDims {
  length_m: number;
  width_m: number;
  wheelbase_m?: number | null;
  visual_offset?: { forward_m: number; up_m: number } | null;
}

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
  /** null when config/cars.yaml doesn't know the car: the views fall back to a generic GT3 size. */
  car_dims: CarDims | null;
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
  /**
   * Metres, the game's world height (+ up) at each grid point, from a shared-memory capture of the track (#94).
   * Experimental. null when the track has no capture; an entry is null where the capture has no path nearby.
   */
  elevation: { lap: (number | null)[]; ref: (number | null)[] } | null;
  /** Edges and kerbs from a shared-memory survey of the track (#97), on the 1 m grid. null when the track has no survey. Experimental. */
  track_survey: TrackSurvey | null;
  lap_car_dims: CarDims | null;
  ref_car_dims: CarDims | null;
  /** `car_id` of each lap's car; the 3D view uses it to find an optional local 3D model (`/local-models/<car_id>.glb`, #102). */
  lap_car_id: string;
  ref_car_id: string;
  /** Display names of those cars (the 3D view's car popover). */
  lap_car_name: string;
  ref_car_name: string;
}

/**
 * A survey of the track (#97). `edge_points` are where a wheel crossed between racing tarmac and anything else, i.e. points
 * on the physical edge; `kerb_outer_points` where a wheel left a kerb for the ground beside it. Both are [lat, lon] (the
 * recording's GPS frame), track-level and unsided: the view decides which side of its centreline each lies on.
 * `left_m` / `right_m` are LMU's own half-widths (metres from its centre path, not the middle of the road) per grid
 * metre, null where unmeasured; they are jumpy (they come from the AI path), so the view only uses them where no edge
 * point was measured.
 * `bank_deg` is the road's banking per grid metre in degrees (positive = the right side lower, seen along the direction of
 * travel), null where unmeasured. It is the body roll of cars driving on tarmac minus what their lateral g explains
 * (see tools/lmu-logger/decode.py), and the cockpit camera adds it to its roll estimate (#100).
 */
export interface TrackSurvey {
  left_m: (number | null)[]; right_m: (number | null)[]; bank_deg: (number | null)[]; kerbs: SurveyKerb[];
  edge_points: [lat: number, lon: number][]; kerb_outer_points: [lat: number, lon: number][];
}

/** A kerb stretch on one side, inclusive grid metres. flat = LMU's flat kerb, razor = the raised kerb. `width_m` is the measured kerb width, null when unknown. */
export interface SurveyKerb { side: "left" | "right"; start_m: number; end_m: number; kind: "flat" | "razor" | "other"; width_m: number | null }

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
