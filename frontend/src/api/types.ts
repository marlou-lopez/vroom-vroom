// TypeScript mirrors of the backend request/response models (Tasks 2, 5, 7, 9-13, 16).
// Field names are snake_case, exactly as in the Python models. Datetimes are ISO-8601 strings.

export const GRID_CHANNELS = [
  "t", "speed_kmh", "throttle", "brake", "steering", "gear", "rpm", "g_lat", "g_long", "yaw_rate",
  "lat", "lon", "path_lateral", "track_edge", "kerb", "susp_fl", "susp_fr", "susp_rl", "susp_rr",
  "abs", "tc", "slip_fl", "slip_fr", "slip_rl", "slip_rr",
] as const;
export type GridChannel = (typeof GRID_CHANNELS)[number];

/**
 * Every grid channel, one value per metre. `steering` is normalised (-1..1); degrees = steering * range / 2.
 * `abs` and `tc` are 0/1: 1 when the aid was active at any moment inside that metre (ABS pulses ~15 ms, so a metre is "on" if any pulse falls in it).
 * `slip_*` are tyre surface speed / ground speed per wheel (FL, FR, RL, RR; < 1 = slower than the road, lockup; > 1 = faster, spin), and 1 below 5 m/s.
 */
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
  /** [sector 1, sector 2, sector 3] durations in seconds, adding up to `lap_time_s`; empty when the lap has none (invalid, out or in lap). */
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
  lap_car_dims: CarDims | null;
  ref_car_dims: CarDims | null;
  /** `car_id` of each lap's car; the 3D view uses it to find an optional local 3D model (`/local-models/<car_id>.glb`, #102). */
  lap_car_id: string;
  ref_car_id: string;
  /** Display names of those cars (the 3D view's car popover). */
  lap_car_name: string;
  ref_car_name: string;
  /**
   * One entry per track-map corner, in map order (#86): the numbers a race engineer checks first, for the table, the coach
   * and the backend alike. A track with no corners in its map gives an empty list.
   */
  corners: CornerMetrics[];
}

/**
 * One corner, lap against reference. Positions are grid metres (0 = start line); a corner that wraps over the start line
 * (start_m > end_m) is measured across it.
 */
export interface CornerMetrics {
  corner_id: string;
  /** Time between the corner's start and end, lap minus reference: positive = time lost, negative = gained. */
  delta_s: number;
  lap: CornerSideMetrics;
  ref: CornerSideMetrics;
}

export interface CornerSideMetrics {
  /** First point from the corner start to the apex where the brake reaches 0.1; null when the corner has no braking before the apex. */
  brake_onset_m: number | null;
  /** Highest brake pressure in the corner, 0..1. */
  peak_brake: number;
  /** Lowest speed in the corner, and where it happens. */
  min_speed_kmh: number;
  min_speed_m: number;
  /** First point from the minimum speed on where the throttle reaches 0.5; null when it never does. */
  throttle_pickup_m: number | null;
  /** Speed at the corner's end. */
  exit_speed_kmh: number;
  /** Seconds with neither pedal pressed (throttle and brake < 0.05) above 50 km/h. First guess, tuned in #25. */
  coast_s: number;
  /** Seconds with both pedals pressed (throttle and brake > 0.1). First guess, tuned in #25. */
  overlap_s: number;
  /** Direction reversals of the smoothed steering (+-5 m, 10 % prominence). Compare with the reference's count: the difference is the extra corrections. */
  steer_corrections: number;
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

// ---- Track geometry ----

/**
 * How the recording's GPS (lat/lon) relates to the game's world x/z, in metres. Verified on Spa (docs/lmu-duckdb-schema.md):
 * `x = lon * R * pi/180 * cos(origin_lat)`, `z = (lat - origin_lat) * R * pi/180`. World `y` is up.
 */
export interface LocalTransform {
  kind: "equirectangular";
  earth_radius_m: number;
  origin_lat_deg: number;
  origin_lon_deg: number;
}

/**
 * Where the LMU-local frame sits on the real Earth: a similarity transform from world x/z (metres) to real lat/lon.
 * Nothing in the recordings or captures pins this down, so it is null until a fit exists (public terrain data is not used
 * yet). Views must work without it.
 */
export interface RealWorldFit {
  /** Real lat/lon (degrees) of world x = 0, z = 0. */
  origin_lat_deg: number;
  origin_lon_deg: number;
  /** Rotation of the local frame against east/north, degrees, and the scale (1 = metres match). */
  rotation_deg: number;
  scale: number;
  /** RMS residual of the fit, metres. */
  rms_m: number;
}

/**
 * Everything the detailed 2D and 3D views need to draw a track, once per track (GET /api/tracks/{id}/geometry).
 * Per-metre arrays share one 1 m grid starting at the start/finish line: index i is i metres along the centreline.
 * Their length is the centreline's, about `length_m`. Edges and kerbs come from all laps and surveys, not one comparison.
 */
export interface TrackGeometry {
  track_id: string;
  /** Track length; the per-metre arrays follow the centreline and may differ by a few metres, so index by their own length. */
  length_m: number;
  /** The centreline in the recording's GPS frame (the line of a flying lap), one point per grid metre. */
  centre: { lat: number[]; lon: number[] };
  /**
   * Metres, the game's world height (+ up) per grid metre, from a shared-memory capture (#94). Experimental.
   * null when the track has no capture; an entry is null where the capture has no path nearby.
   */
  elevation_m: (number | null)[] | null;
  /** Edges, kerbs and banking from a shared-memory survey (#97), on the same grid. null when the track has no survey. */
  survey: TrackSurvey | null;
  /**
   * Share of the grid (0..1) where each side's edge is known, i.e. non-null in `survey.left_m` / `right_m`: measured, or
   * interpolated across gaps of at most 8 m between samples. Lets later work (3D, coach facts) skip unmeasured stretches. null when there is no survey.
   */
  coverage: { left: number; right: number } | null;
  transform: { local: LocalTransform; real_world: RealWorldFit | null };
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

/** A hand-added landmark. The server assigns the id and marks it confirmed. */
export type NewLandmark = Omit<Landmark, "id" | "confidence">;

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

// ---- Ideal lap ----

/** `session`: the best segments of one session's laps. `all`: of every session on the same track and car. */
export type IdealScope = "session" | "all";

/** One segment of the track map (a corner, or the straight between two corners) and the lap that holds its best time. */
export interface IdealSegment {
  label: string;
  /** The corner this segment is; null for a straight. */
  corner_id: string | null;
  start_m: number;
  end_m: number;
  best_s: number;
  lap_id: string;
  lap_no: number;
  session_id: string;
}

/**
 * GET /api/sessions/{session_id}/ideal?scope=session|all. `time_s` is the sum of the segments' `best_s`, never above the best valid
 * lap. Only valid flying laps count (never invalid, out or in laps). Segments follow the track map's corners as they are now, so
 * this is recomputed rather than stored. For scope=session, `SessionSummary.theoretical_best_s` equals `time_s`.
 */
export interface IdealLap {
  time_s: number;
  scope: IdealScope;
  segments: IdealSegment[];
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

// ---- Stint (EXPERIMENTAL, vroom-pnw.26) ----
// Spike prototype: not part of the agreed contract yet. See docs/stint/stint-view.md for the contract options.

/** One value per wheel. */
export interface Wheels { fl: number; fr: number; rl: number; rr: number }

/** Per-lap stint stats, computed from the recording's fuel, virtual energy, tyre and brake channels. */
export interface StintLap {
  lap_no: number;
  kind: LapKind;
  /** Official time; 0 = invalid, null = none (a lap that ends in the pits or with the recording). */
  lap_time_s: number | null;
  valid: boolean;
  fuel_start_l: number;
  fuel_end_l: number;
  /** Virtual energy left, percent of the full tank. null when the car has no virtual energy (the channel reads 0). */
  energy_start_pct: number | null;
  energy_end_pct: number | null;
  /** Lap mean of the tread surface temperature (mean of the three zones). */
  tyre_surface_c: Wheels;
  /** Lap means per tread zone; `left` and `right` are the car's left and right edges of the tread. */
  tyre_zones_c: { left: Wheels; centre: Wheels; right: Wheels };
  tyre_carcass_c: Wheels;
  tyre_pressure_kpa: Wheels;
  /** Tread left at the end of the lap, percent (100 = new). */
  tyre_wear_end_pct: Wheels;
  /** Lap mean of the brake disc temperature. */
  brake_c: Wheels;
  track_temp_c: number;
  air_temp_c: number;
}

/** A run of laps from one recording (here: a whole session, pit stop included). */
export interface Stint {
  stint_id: string;
  track_id: string;
  car_id: string;
  car_class: string;
  session_type: string;
  started_at: string;
  source: string;
  laps: StintLap[];
}
