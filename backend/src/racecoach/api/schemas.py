"""Response models of the JSON routes: the shapes of `frontend/src/api/types.ts`.

Routes still return plain dicts or domain models; FastAPI validates them against these models,
so a route that drifts from the contract fails in the tests instead of in the browser, and
`/openapi.json` carries the response shapes that `frontend/src/api/contract.test.ts` checks
`types.ts` against. Large arrays keep their format (lists of numbers).
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

from racecoach.model import LapKind, LapSource

# ---- sessions and laps ----


class VisualOffset(BaseModel):
    forward_m: float
    up_m: float


class CarDims(BaseModel):
    length_m: float
    width_m: float
    wheelbase_m: float | None = None
    visual_offset: VisualOffset | None = None


class SessionMetaOut(BaseModel):
    session_id: str
    track_name: str
    track_layout: str
    track_id: str
    track_length_m: float
    car_name: str
    car_id: str
    car_class: str
    session_type: str
    game_build: str
    started_at: str
    driver: str
    steering_range_deg: float | None
    car_dims: CarDims | None


class LapMetaOut(BaseModel):
    lap_id: str
    session_id: str
    lap_no: int
    kind: LapKind
    lap_time_s: float | None
    sectors_s: list[float]
    valid: bool
    valid_override: bool | None
    pinned_reference: bool
    source: LapSource
    driver: str
    track_id: str
    car_id: str
    has_trace: bool


class LapWithRefOut(LapMetaOut):
    is_reference: bool


class ChannelArrays(BaseModel):
    """One list of numbers per grid channel (`GRID_CHANNELS`; a test keeps them equal)."""

    t: list[float]
    speed_kmh: list[float]
    throttle: list[float]
    brake: list[float]
    steering: list[float]
    gear: list[float]
    rpm: list[float]
    g_lat: list[float]
    g_long: list[float]
    yaw_rate: list[float]
    lat: list[float]
    lon: list[float]
    path_lateral: list[float]
    track_edge: list[float]
    kerb: list[float]
    susp_fl: list[float]
    susp_fr: list[float]
    susp_rl: list[float]
    susp_rr: list[float]
    abs: list[float]
    tc: list[float]
    slip_fl: list[float]
    slip_fr: list[float]
    slip_rl: list[float]
    slip_rr: list[float]
    wheels_off: list[float]


class TraceResponse(BaseModel):
    distance: list[float]
    ch: dict[str, list[float]]


# ---- compare ----


class BalanceRun(BaseModel):
    start_m: int
    end_m: int


class CornerSideMetrics(BaseModel):
    brake_onset_m: float | None
    peak_brake: float
    min_speed_kmh: float
    min_speed_m: float
    throttle_pickup_m: float | None
    exit_speed_kmh: float
    coast_s: float
    overlap_s: float
    steer_corrections: int
    understeer_peak_deg_s: float | None
    understeer_mean_deg_s: float | None


class CornerMetrics(BaseModel):
    corner_id: str
    delta_s: float
    lap: CornerSideMetrics
    ref: CornerSideMetrics


class CompareResponse(BaseModel):
    lap_id: str
    ref_lap_id: str
    lap_kind: LapKind
    ref_kind: LapKind
    distance: list[float]
    lap: ChannelArrays
    ref: ChannelArrays
    delta: list[float]
    warning: str | None
    lap_steering_range_deg: float | None
    ref_steering_range_deg: float | None
    lap_car_dims: CarDims | None
    ref_car_dims: CarDims | None
    lap_car_id: str
    ref_car_id: str
    lap_car_name: str
    ref_car_name: str
    corners: list[CornerMetrics]
    lap_balance: list[float | None] | None
    ref_balance: list[float | None] | None
    lap_understeer_runs: list[BalanceRun]
    ref_understeer_runs: list[BalanceRun]
    lap_oversteer_runs: list[BalanceRun]
    ref_oversteer_runs: list[BalanceRun]
    ref_joins_m: list[int]


class CompareCandidate(BaseModel):
    lap_id: str
    label: str
    lap_time_s: float | None
    car_name: str
    is_reference: bool
    is_previous: bool
    other_car: bool
    is_ideal: bool


# ---- track geometry ----


class SurveyKerb(BaseModel):
    side: Literal["left", "right"]
    start_m: int
    end_m: int
    kind: Literal["flat", "razor", "other"]
    width_m: float | None


class TrackSurvey(BaseModel):
    left_m: list[float | None]
    right_m: list[float | None]
    bank_deg: list[float | None]
    kerbs: list[SurveyKerb]
    edge_points: list[tuple[float, float]]
    kerb_outer_points: list[tuple[float, float]]


class EdgeCoverage(BaseModel):
    left: float
    right: float


class TelemetryEdges(BaseModel):
    left_m: list[float | None]
    right_m: list[float | None]
    kerbs: list[SurveyKerb]
    coverage: EdgeCoverage
    laps: int


class AerialEdges(BaseModel):
    edge_points: list[tuple[float, float]]
    kerbs: list[SurveyKerb]
    attribution: str
    licence_url: str | None


class LocalTransform(BaseModel):
    kind: Literal["equirectangular"]
    earth_radius_m: float
    origin_lat_deg: float
    origin_lon_deg: float


class RealWorldFit(BaseModel):
    origin_lat_deg: float
    origin_lon_deg: float
    rotation_deg: float
    scale: float
    rms_m: float


class GeometryTransform(BaseModel):
    local: LocalTransform
    real_world: RealWorldFit | None


class Centreline(BaseModel):
    lat: list[float]
    lon: list[float]


class TrackGeometry(BaseModel):
    track_id: str
    length_m: float
    centre: Centreline
    elevation_m: list[float | None] | None
    survey: TrackSurvey | None
    aerial: AerialEdges | None
    coverage: EdgeCoverage | None
    telemetry: TelemetryEdges | None
    transform: GeometryTransform


# ---- tracks ----


class DetectedCorner(BaseModel):
    apex_m: float
    start_m: float
    end_m: float
    min_speed_kmh: float
    flat: bool


class CalibrationResultOut(BaseModel):
    map: TrackMapOut
    unmapped: list[DetectedCorner]
    missing: list[str]


# ---- session views ----


class SessionFocus(BaseModel):
    instruction: str
    improved: bool | None


class SessionSummary(BaseModel):
    n_laps: int
    n_valid: int
    best_lap_s: float | None
    theoretical_best_s: float | None
    track_temp_c: float | None
    focus: SessionFocus | None


class CarSetupEntry(BaseModel):
    key: str
    label: str
    value: str


class CarSetup(BaseModel):
    entries: list[CarSetupEntry]


class IdealSegment(BaseModel):
    label: str
    corner_id: str | None
    start_m: float
    end_m: float
    best_s: float
    lap_id: str
    lap_no: int
    session_id: str


class IdealLap(BaseModel):
    time_s: float
    scope: Literal["session", "all"]
    segments: list[IdealSegment]


class LapSegmentTimes(BaseModel):
    lap_id: str
    lap_no: int
    segment_s: list[float]


class SegmentTimes(BaseModel):
    laps: list[LapSegmentTimes]


# ---- import and usage ----


class ImportResult(BaseModel):
    session_id: str
    n_laps: int
    skipped: bool


class LlmCall(BaseModel):
    command: str
    provider: str
    model: str
    input_tokens: int
    output_tokens: int
    cost_usd: float | None
    ok: bool
    created_at: str


class LlmUsage(BaseModel):
    calls: list[LlmCall]
    total_usd: float


# ---- session report ----

ReportCategory = Literal["tyres", "brakes", "driving", "settings", "pace", "conditions"]


class Axles(BaseModel):
    front: float
    rear: float


class ReportLap(BaseModel):
    lap_id: str
    lap_no: int
    kind: LapKind
    lap_time_s: float | None
    valid: bool
    has_trace: bool
    tyre_surface_c: Axles | None
    tyre_carcass_c: Axles | None
    tyre_pressure_kpa: Axles | None
    brake_c: Axles | None
    track_temp_c: float | None
    fuel_end_l: float | None
    energy_end_pct: float | None
    settings: dict[str, float] | None


class ReportCoincidence(BaseModel):
    scope: Literal["lap", "corner"]
    lost_s: float
    laps: list[int]


class ReportCorner(BaseModel):
    id: str
    name: str


class ReportEvent(BaseModel):
    id: str
    category: ReportCategory
    kind: str
    severity: Literal["info", "watch", "problem"]
    lap_from: int
    lap_to: int
    corner: ReportCorner | None
    distance_m: float | None
    numbers: dict[str, float]
    coincides: ReportCoincidence | None
    sentence: str


class ReportWindow(BaseModel):
    key: str
    unit: str
    axle: Literal["both", "front", "rear"]
    tolerance: float
    min: float
    max: float
    source: str


class ReportUnavailable(BaseModel):
    category: ReportCategory
    reason: str


class SessionReport(BaseModel):
    session_id: str
    car_class: str
    compound: str
    laps: list[ReportLap]
    events: list[ReportEvent]
    windows: list[ReportWindow]
    unavailable: list[ReportUnavailable]


# The map, coach and stint shapes already are Pydantic models in the domain code.
from racecoach.coach.schema import CoachResult as CoachResultOut  # noqa: E402
from racecoach.coach.schema import Finding as FindingOut  # noqa: E402
from racecoach.stint import Stint as StintOut  # noqa: E402
from racecoach.tracks import TrackMap as TrackMapOut  # noqa: E402

CalibrationResultOut.model_rebuild()

__all__ = [
    "CoachResultOut", "FindingOut", "StintOut", "TrackMapOut",
]  # fmt: skip
