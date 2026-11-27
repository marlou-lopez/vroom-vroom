"""Every route of the frontend's `Api` interface (`frontend/src/api/client.ts`)."""

from __future__ import annotations

import threading
import uuid
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

import numpy as np
from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel

from racecoach.analysis.consistency import (
    FocusItem,
    NoValidLaps,
    evaluate_focus,
    ideal_lap,
    is_timed,
    timed_laps,
)
from racecoach.analysis.corners import detect_corners
from racecoach.api import schemas as S
from racecoach.api import views
from racecoach.api.errors import ApiError
from racecoach.coach.packet import build_packet  # noqa: F401  (kept importable for tests)
from racecoach.coach.schema import CoachResult, Command
from racecoach.coach.service import run_coach
from racecoach.edges import telemetry_edges
from racecoach.geometry import build_geometry, track_data_files
from racecoach.importer import import_file
from racecoach.model import GRID_CHANNELS, LapKind, LapMeta, LapSource, LapTrace, SessionMeta
from racecoach.report import ReportInput, ReportLapInput, build_report, trace_facts
from racecoach.settings import Settings
from racecoach.setup_labels import setup_label
from racecoach.stint import session_stints
from racecoach.store import AppStore
from racecoach.tracks import Landmark, TrackMap, calibrate, load_map, map_for, save_map

router = APIRouter(prefix="/api")


def get_store(request: Request) -> AppStore:
    return request.app.state.store.view()


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


Store = Annotated[AppStore, Depends(get_store)]
Cfg = Annotated[Settings, Depends(get_settings)]


# --- lookups -----------------------------------------------------------------------------------


def need_session(store: AppStore, session_id: str) -> SessionMeta:
    s = store.session(session_id)
    if s is None:
        raise ApiError("unknown_session", f"Session {session_id} is not in the store.")
    return s


def need_lap(store: AppStore, lap_id: str) -> LapMeta:
    lap = store.lap(lap_id)
    if lap is None:
        raise ApiError("unknown_lap", f"Lap {lap_id} is not in the store.")
    return lap


def need_trace(store: AppStore, lap_id: str) -> LapTrace:
    try:
        return store.read_trace(lap_id)
    except KeyError:
        raise ApiError("no_trace", f"Lap {lap_id} has no trace.") from None


def session_pairs(store: AppStore, session_id: str) -> list[tuple[LapMeta, LapTrace]]:
    out = []
    for m in store.laps(session_id):
        if store.trace_path(m.lap_id).is_file():
            out.append((m, store.read_trace(m.lap_id)))
    return out


def track_reference(store: AppStore, track_id: str) -> LapMeta | None:
    """The best reference lap of a track over its cars."""
    best: LapMeta | None = None
    for car_id in sorted({s.car_id for s in store.sessions() if s.track_id == track_id}):
        ref = store.reference_for(track_id, car_id)
        if ref and (best is None or (ref.lap_time_s or 1e9) < (best.lap_time_s or 1e9)):
            best = ref
    return best


def need_map(store: AppStore, settings: Settings, track_id: str) -> TrackMap:
    saved = load_map(settings.tracks_dir, track_id)
    if saved is not None and not any(c.approx for c in saved.corners):
        return saved
    ref = track_reference(store, track_id)
    if ref is None or not store.trace_path(ref.lap_id).is_file():
        if saved is not None:
            return saved
        raise ApiError("unknown_track", f"Track {track_id} has no laps and no map.")
    return map_for(settings.tracks_dir, track_id, store.read_trace(ref.lap_id))


# --- sessions and laps -------------------------------------------------------------------------


@router.get("/sessions", response_model=list[S.SessionMetaOut])
def sessions(store: Store) -> list[dict[str, Any]]:
    return [views.session_json(s) for s in store.sessions()]


@router.get("/sessions/{session_id}/laps", response_model=list[S.LapWithRefOut])
def session_laps(session_id: str, store: Store) -> list[dict[str, Any]]:
    s = need_session(store, session_id)
    ref = store.reference_for(s.track_id, s.car_id)
    return [views.lap_json(m, store, ref, True) for m in store.laps(session_id)]


@router.get("/laps/{lap_id}", response_model=S.LapWithRefOut)
def one_lap(lap_id: str, store: Store) -> dict[str, Any]:
    lap = need_lap(store, lap_id)
    ref = store.reference_for(lap.track_id, lap.car_id)
    return views.lap_json(lap, store, ref, True)


class LapPatch(BaseModel):
    valid_override: bool | None = None
    pinned_reference: bool | None = None
    model_config = {"extra": "forbid"}


@router.patch("/laps/{lap_id}", response_model=S.LapMetaOut)
def patch_lap(lap_id: str, patch: LapPatch, store: Store) -> dict[str, Any]:
    need_lap(store, lap_id)
    sent = patch.model_fields_set
    if "valid_override" in sent:
        store.set_valid_override(lap_id, patch.valid_override)
    if "pinned_reference" in sent and patch.pinned_reference is not None:
        if patch.pinned_reference:
            store.pin_reference(lap_id)
        else:
            store.unpin_reference(lap_id)
    return views.lap_json(need_lap(store, lap_id), store)


@router.get("/laps/{lap_id}/trace", response_model=S.TraceResponse)
def lap_trace(lap_id: str, store: Store, channels: str | None = None) -> dict[str, Any]:
    need_lap(store, lap_id)
    trace = need_trace(store, lap_id)
    names = [c for c in (channels or "").split(",") if c]
    bad = [c for c in names if c not in GRID_CHANNELS]
    if bad:
        raise ApiError("bad_request", f"Unknown channel: {', '.join(bad)}")
    n = len(trace.distance)
    return {
        "distance": views.series(trace.distance, 0),
        "ch": views.channels_json(trace, n, names or None),
    }


# --- compare -----------------------------------------------------------------------------------


def _ideal_for(store: AppStore, settings: Settings, lap: LapMeta, ref_id: str) -> tuple[Any, ...]:
    sid = ref_id[len(views.IDEAL_PREFIX) :]
    if sid != lap.session_id:
        raise ApiError("unknown_lap", f"The ideal lap {ref_id} is not this lap's session's.")
    s = need_session(store, sid)
    tmap = need_map(store, settings, s.track_id)
    return session_pairs(store, sid), tmap


@router.get("/compare", response_model=S.CompareResponse)
def compare(lap: str, store: Store, settings: Cfg, ref: str | None = None) -> dict[str, Any]:
    lap_meta = need_lap(store, lap)
    lap_s = need_session(store, lap_meta.session_id)
    lap_tr = need_trace(store, lap)
    if ref is not None and ref.startswith(views.IDEAL_PREFIX):
        pairs, tmap = _ideal_for(store, settings, lap_meta, ref)
        trace, joins, _ = views.stitch_ideal(pairs, tmap, (lap_meta, lap_tr))
        ref_pair = (replace(lap_meta, lap_id=ref, kind=LapKind.FLYING), trace)
        return views.compare_json(
            (lap_meta, lap_tr), ref_pair, lap_s, None, tmap, ref_id=ref, ref_kind="flying",
            ref_car_name=lap_s.car_name, ref_range=lap_s.steering_range_deg, joins=joins,
            warning=None,
        )  # fmt: skip
    if ref is None:
        ref_meta = store.reference_for(lap_s.track_id, lap_s.car_id)
        if ref_meta is None:
            raise ApiError("no_reference", "There is no valid timed lap to compare this lap with.")
    else:
        ref_meta = need_lap(store, ref)
    if ref_meta.track_id != lap_meta.track_id:
        raise ApiError("track_mismatch", "The two laps are on different tracks or layouts.")
    ref_s = need_session(store, ref_meta.session_id)
    ref_tr = need_trace(store, ref_meta.lap_id)
    tmap = need_map(store, settings, lap_s.track_id)
    warning = None
    if ref_s.car_id != lap_s.car_id:
        warning = f"The comparison lap was driven in a different car ({ref_s.car_name})."
    return views.compare_json(
        (lap_meta, lap_tr), (ref_meta, ref_tr), lap_s, ref_s, tmap, ref_id=ref_meta.lap_id,
        ref_kind=ref_meta.kind.value, ref_car_name=ref_s.car_name,
        ref_range=ref_s.steering_range_deg, joins=[], warning=warning,
    )  # fmt: skip


def _time_text(s: float | None) -> str:
    if not s:
        return "no time"
    m, sec = divmod(s, 60)
    return f"{int(m)}:{sec:06.3f}"


@router.get("/laps/{lap_id}/compare-candidates", response_model=list[S.CompareCandidate])
def compare_candidates(lap_id: str, store: Store, settings: Cfg) -> list[dict[str, Any]]:
    lap = need_lap(store, lap_id)
    sess = {s.session_id: s for s in store.sessions()}
    ref = store.reference_for(lap.track_id, lap.car_id)
    out: list[dict[str, Any]] = []
    try:
        pool = [p for p in session_pairs(store, lap.session_id) if p[0].lap_time_s]  # noqa: E501
        ideal = ideal_lap(pool, need_map(store, settings, lap.track_id), "session")
        label = f"Ideal lap (session) {_time_text(ideal.time_s)}"
        out.append({
            "lap_id": f"{views.IDEAL_PREFIX}{lap.session_id}", "label": label,
            "lap_time_s": ideal.time_s, "car_name": sess[lap.session_id].car_name,
            "is_reference": False, "is_previous": False, "other_car": False, "is_ideal": True,
        })  # fmt: skip
    except (NoValidLaps, ApiError):
        pass
    cands = [
        m for m in store.laps()
        if m.track_id == lap.track_id and m.lap_id != lap.lap_id and m.lap_time_s
        and m.kind.value == "flying" and store.trace_path(m.lap_id).is_file()
    ]  # fmt: skip
    cands.sort(key=lambda m: (m.lap_time_s or 0.0, m.lap_id))
    for m in cands:
        s = sess[m.session_id]
        out.append({
            "lap_id": m.lap_id,
            "label": f"Lap {m.lap_no} · {_time_text(m.lap_time_s)} · {s.started_at:%d %b %Y}",
            "lap_time_s": m.lap_time_s, "car_name": s.car_name,
            "is_reference": ref is not None and ref.lap_id == m.lap_id,
            "is_previous": m.session_id == lap.session_id and m.lap_no == lap.lap_no - 1,
            "other_car": m.car_id != lap.car_id, "is_ideal": False,
        })  # fmt: skip
    return out


# --- tracks ------------------------------------------------------------------------------------


@router.get("/tracks/{track_id}/map", response_model=S.TrackMapOut)
def track_map(track_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    return need_map(store, settings, track_id).model_dump(mode="json")


def _centreline_lap(store: AppStore, track_id: str) -> tuple[LapMeta, float] | None:
    """The track's reference lap (metadata only: no trace is read) and the track length."""
    ref = track_reference(store, track_id)
    if ref is None or not store.trace_path(ref.lap_id).is_file():
        return None
    length = next(s.track_length_m for s in store.sessions() if s.track_id == track_id)
    return ref, length


_geometry_lock = threading.Lock()
_EDGE_CHANNELS = ("path_lateral", "track_edge", "kerb", "speed_kmh")


def _telemetry_fallback(store: AppStore, track_id: str, n: int) -> dict[str, Any]:
    """Edges and kerbs from every lap of the track that has a trace (vroom-ohw)."""
    laps = []
    for lap_id in _track_lap_ids(store, track_id):
        trace = store.read_trace(lap_id)
        if not all(c in trace.ch for c in _EDGE_CHANNELS):
            continue
        # An out-lap's grid starts where it left the pits: index by distance, not position.
        idx = trace.distance.astype(int)
        keep = (idx >= 0) & (idx < n)
        lap = {}
        for c in _EDGE_CHANNELS:
            full = np.full(n, np.nan)
            full[idx[keep]] = trace.ch[c][keep]
            lap[c] = full
        laps.append(lap)
    return telemetry_edges(laps, n)


def _track_lap_ids(store: AppStore, track_id: str) -> tuple[str, ...]:
    sids = {s.session_id for s in store.sessions() if s.track_id == track_id}
    laps = (x for x in store.laps() if x.session_id in sids)
    return tuple(x.lap_id for x in laps if store.trace_path(x.lap_id).is_file())


@router.get("/tracks/{track_id}/geometry", response_model=S.TrackGeometry)
def track_geometry(track_id: str, request: Request, store: Store, settings: Cfg) -> dict[str, Any]:
    """A track's centreline, elevation, edges and kerbs; cached until the line or data change."""
    found = _centreline_lap(store, track_id)
    if found is None:
        raise ApiError("unknown_track", f"No laps on {track_id}, so no geometry.")
    lap, length = found
    files = track_data_files(settings.track_data_path, track_id)
    stamp = tuple(f.stat().st_mtime_ns if f.is_file() else None for f in files.values())
    # No survey: edges and kerbs come from all the track's laps, so a new lap refreshes them.
    fallback = not files["survey"].is_file()
    key = (track_id, lap.lap_id, stamp, _track_lap_ids(store, track_id) if fallback else None)
    with _geometry_lock:
        if not hasattr(request.app.state, "geometry_cache"):
            request.app.state.geometry_cache = {}
        cache: dict[Any, dict[str, Any]] = request.app.state.geometry_cache
        if key not in cache:
            ch = need_trace(store, lap.lap_id).ch
            for k in [k for k in cache if k[0] == track_id]:
                cache.pop(k, None)
            tel = _telemetry_fallback(store, track_id, len(ch["lat"])) if fallback else None
            cache[key] = build_geometry(
                track_id, length, ch["lat"], ch["lon"], settings.track_data_path, tel
            )
        return cache[key]


class NewLandmark(BaseModel):
    label: str
    kind: Literal["brake_board", "kerb_entry", "kerb_apex", "kerb_exit", "custom"]
    distance_m: float
    corner_id: str | None = None


class LandmarkPatch(BaseModel):
    confirm: bool | None = None
    distance_m: float | None = None


def _landmark_index(m: TrackMap, landmark_id: str) -> int:
    for i, lm in enumerate(m.landmarks):
        if lm.id == landmark_id:
            return i
    raise ApiError("unknown_landmark", f"Landmark {landmark_id} is not on this track's map.")


@router.post("/tracks/{track_id}/landmarks", response_model=S.TrackMapOut)
def add_landmark(track_id: str, new: NewLandmark, store: Store, settings: Cfg) -> dict[str, Any]:
    m = need_map(store, settings, track_id)
    lm = Landmark(id=f"lm-{uuid.uuid4().hex[:8]}", confidence="confirmed", **new.model_dump())
    m = m.model_copy(update={"landmarks": [*m.landmarks, lm]})
    save_map(settings.tracks_dir, m)
    return m.model_dump(mode="json")


@router.patch("/tracks/{track_id}/landmarks/{landmark_id}", response_model=S.TrackMapOut)
def patch_landmark(
    track_id: str, landmark_id: str, patch: LandmarkPatch, store: Store, settings: Cfg
) -> dict[str, Any]:
    m = need_map(store, settings, track_id)
    i = _landmark_index(m, landmark_id)
    upd: dict[str, Any] = {}
    if patch.distance_m is not None:
        upd["distance_m"] = patch.distance_m
    if patch.confirm:
        upd["confidence"] = "confirmed"
    marks = list(m.landmarks)
    marks[i] = marks[i].model_copy(update=upd)
    m = m.model_copy(update={"landmarks": marks})
    save_map(settings.tracks_dir, m)
    return m.model_dump(mode="json")


@router.delete("/tracks/{track_id}/landmarks/{landmark_id}", response_model=S.TrackMapOut)
def delete_landmark(track_id: str, landmark_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    m = need_map(store, settings, track_id)
    i = _landmark_index(m, landmark_id)
    m = m.model_copy(update={"landmarks": [lm for k, lm in enumerate(m.landmarks) if k != i]})
    save_map(settings.tracks_dir, m)
    return m.model_dump(mode="json")


@router.post("/tracks/{track_id}/calibrate", response_model=S.CalibrationResultOut)
def calibrate_track(track_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    ref = track_reference(store, track_id)
    if ref is None or not store.trace_path(ref.lap_id).is_file():
        raise ApiError(
            "no_reference", "Calibration needs a best lap to compare with, and this track has none."
        )
    saved = load_map(settings.tracks_dir, track_id)
    if saved is None:
        raise ApiError("unknown_track", f"Track {track_id} has no map to calibrate.")
    res = calibrate(saved, detect_corners(store.read_trace(ref.lap_id)))
    save_map(settings.tracks_dir, res.map)
    return {
        "map": res.map.model_dump(mode="json"),
        "unmapped": [d.__dict__ for d in res.unmapped],
        "missing": res.missing,
    }


# --- coach -------------------------------------------------------------------------------------


class CoachRequest(BaseModel):
    command: Command
    lap_id: str
    ref_lap_id: str | None = None
    corner_id: str | None = None


def _no_findings(store: AppStore, lap: LapMeta, req: CoachRequest) -> CoachResult:
    result = CoachResult(
        id=uuid.uuid4().hex, command=req.command, lap_id=lap.lap_id, ref_lap_id=lap.lap_id,
        summary="This lap is the comparison lap, so there is nothing to compare.",
        findings=[], focus=None, encouragement=None, stats={}, warnings=[], cost_usd=0.0,
        created_at=datetime.now(UTC).isoformat(),
    )  # fmt: skip
    return store.save_coach_result(result)


@router.post("/coach", response_model=S.CoachResultOut)
def coach(req: CoachRequest, store: Store, settings: Cfg) -> dict[str, Any]:
    lap = need_lap(store, req.lap_id)
    if req.command != "average":
        own = req.ref_lap_id == lap.lap_id
        if req.ref_lap_id is None:
            ref = store.reference_for(lap.track_id, lap.car_id)
            own = ref is not None and ref.lap_id == lap.lap_id
        if own:
            return _no_findings(store, lap, req).model_dump(mode="json")
    result = run_coach(store, settings, req.command, req.lap_id, req.ref_lap_id, req.corner_id)
    return result.model_dump(mode="json")


@router.get("/coach/results", response_model=dict[str, S.CoachResultOut])
def coach_results(lap: str, store: Store, ref: str | None = None) -> dict[str, Any]:
    found = store.latest_coach_results(lap, ref)
    return {c: r.model_dump(mode="json") for c, r in found.items()}


class FindingPatch(BaseModel):
    reviewed: bool


@router.patch("/coach/findings/{finding_id}", response_model=S.FindingOut)
def patch_finding(finding_id: str, patch: FindingPatch, store: Store) -> dict[str, Any]:
    try:
        result = store.set_finding_reviewed(finding_id, patch.reviewed)
    except KeyError:
        raise ApiError("unknown_finding", f"Finding {finding_id} was not found.") from None
    return next(f for f in result.findings if f.id == finding_id).model_dump(mode="json")


# --- session views -----------------------------------------------------------------------------


@router.get("/sessions/{session_id}/summary", response_model=S.SessionSummary)
def session_summary(session_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    s = need_session(store, session_id)
    metas = store.laps(session_id)
    timed = [m for m in metas if is_timed(m)]
    stats = store.stint_stats(session_id)
    temps = [v.get("track_temp_c") for v in stats.values() if v.get("track_temp_c") is not None]
    theoretical = None
    focus = None
    pairs = session_pairs(store, session_id)
    try:
        tmap = need_map(store, settings, s.track_id)
        if timed_laps(pairs):
            theoretical = ideal_lap(pairs, tmap, "session").time_s
        items = store.focus_items(s.track_id, s.car_id, "open")
        if items:
            it = items[-1]
            improved = None
            if it["corner_id"] and it["baseline_s"] is not None:
                improved = evaluate_focus(
                    FocusItem(it["corner_id"], it["text"], it["baseline_s"]), pairs, tmap
                )
            focus = {"instruction": it["text"], "improved": improved}
    except ApiError:
        pass
    return {
        "n_laps": len(metas), "n_valid": len(timed),
        "best_lap_s": min((m.lap_time_s for m in timed if m.lap_time_s), default=None),
        "theoretical_best_s": theoretical,
        "track_temp_c": float(temps[0]) if temps and temps[0] is not None else None,
        "focus": focus,
    }  # fmt: skip


@router.get("/sessions/{session_id}/setup", response_model=S.CarSetup)
def session_setup(session_id: str, store: Store) -> dict[str, Any]:
    need_session(store, session_id)
    # empty when the recording has no setup: unknown, not "none"
    setup = store.session_setup(session_id)
    return {"entries": [{"key": k, "label": setup_label(k), "value": v} for k, v in setup.items()]}


@router.get("/sessions/{session_id}/ideal", response_model=S.IdealLap)
def session_ideal(
    session_id: str, store: Store, settings: Cfg, scope: Literal["session", "all"] = "session"
) -> dict[str, Any]:
    s = need_session(store, session_id)
    tmap = need_map(store, settings, s.track_id)
    if scope == "session":
        pairs = session_pairs(store, session_id)
    else:
        pairs = []
        for o in store.sessions():  # oldest first: a tie goes to the older lap
            if o.track_id == s.track_id and o.car_id == s.car_id:
                pairs += session_pairs(store, o.session_id)
    return views.ideal_json(ideal_lap(pairs, tmap, scope))


@router.get("/sessions/{session_id}/segment-times", response_model=S.SegmentTimes)
def segment_times(session_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    s = need_session(store, session_id)
    tmap = need_map(store, settings, s.track_id)
    pairs = session_pairs(store, session_id)
    if not timed_laps(pairs):
        raise NoValidLaps("There is no valid timed lap in this session.")
    return views.segment_times_json(pairs, tmap)


@router.get("/sessions/{session_id}/stints", response_model=list[S.StintOut])
def stints(session_id: str, store: Store) -> list[dict[str, Any]]:
    try:
        found = session_stints(store, session_id)
    except KeyError:
        raise ApiError("unknown_session", f"Session {session_id} is not in the store.") from None
    return [s.model_dump(mode="json") for s in found]


@router.get("/sessions/{session_id}/report", response_model=S.SessionReport)
def session_report(session_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    """The session report: per-lap series, the events the fixed rules find (`racecoach.report`,
    a port of `frontend/src/lib/sessionReport.ts`) and the working windows. Categories whose input
    is not stored (the in-car setting events, stint stats, traces) are listed as unavailable."""
    s = need_session(store, session_id)
    stints = session_stints(store, session_id)
    stats = [lap for st in stints for lap in st.laps] or None
    try:
        corners = need_map(store, settings, s.track_id).corners
    except ApiError:
        corners = []
    metas = store.laps(session_id)
    inputs, traces, activation = [], {}, {}
    for m in metas:
        has_trace = store.trace_path(m.lap_id).is_file()
        inputs.append(ReportLapInput(
            m.lap_id, m.lap_no, m.kind.value, m.lap_time_s, m.effective_valid, has_trace
        ))  # fmt: skip
        if has_trace:
            facts = trace_facts(store.read_trace(m.lap_id), corners)
            traces[m.lap_no] = facts
            if facts.aids:
                activation[m.lap_no] = {
                    k: float(sum(e - b + 1 for b, e in facts.aids[a]))
                    for k, a in (("abs_m", "abs"), ("tc_m", "tc"))
                }  # fmt: skip
    return build_report(ReportInput(
        session_id, s.car_class, inputs, stats, stints, corners, traces, activation
    ))  # fmt: skip


# --- import and usage --------------------------------------------------------------------------


class ImportRequest(BaseModel):
    path: str


@router.post("/import", response_model=S.ImportResult)
def import_recording(req: ImportRequest, store: Store, settings: Cfg) -> dict[str, Any]:
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise ApiError("file_not_found", f"{req.path} is not a file.")
    try:
        res = import_file(store, path, settings.raw_dir, LapSource.IMPORTED_FILE)
    except Exception as e:  # a corrupt, locked or foreign file: report it, do not crash
        raise ApiError("import_failed", f"The recording could not be imported: {e}") from e
    return {"session_id": res.session_id, "n_laps": res.lap_count, "skipped": not res.imported}


@router.get("/llm/usage", response_model=S.LlmUsage)
def llm_usage(store: Store) -> dict[str, Any]:
    return {
        "calls": [
            {
                "command": c["purpose"], "provider": c["provider"], "model": c["model"],
                "input_tokens": c["input_tokens"], "output_tokens": c["output_tokens"],
                "cost_usd": c["cost_usd"], "ok": c["ok"],
                "created_at": c["ts"].replace(tzinfo=UTC).isoformat(),
            }
            for c in store.llm_calls()
        ],
        "total_usd": round(store.llm_cost_total(), 6),
    }  # fmt: skip
