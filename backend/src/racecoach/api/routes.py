"""Every route of the frontend's `Api` interface (`frontend/src/api/client.ts`)."""

from __future__ import annotations

import uuid
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Annotated, Any, Literal

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
from racecoach.api import views
from racecoach.api.errors import ApiError
from racecoach.coach.packet import build_packet  # noqa: F401  (kept importable for tests)
from racecoach.coach.schema import CoachResult, Command
from racecoach.coach.service import run_coach
from racecoach.importer import import_file
from racecoach.model import GRID_CHANNELS, LapKind, LapMeta, LapSource, LapTrace, SessionMeta
from racecoach.settings import Settings
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


@router.get("/sessions")
def sessions(store: Store) -> list[dict[str, Any]]:
    return [views.session_json(s) for s in store.sessions()]


@router.get("/sessions/{session_id}/laps")
def session_laps(session_id: str, store: Store) -> list[dict[str, Any]]:
    s = need_session(store, session_id)
    ref = store.reference_for(s.track_id, s.car_id)
    return [views.lap_json(m, store, ref, True) for m in store.laps(session_id)]


@router.get("/laps/{lap_id}")
def one_lap(lap_id: str, store: Store) -> dict[str, Any]:
    lap = need_lap(store, lap_id)
    ref = store.reference_for(lap.track_id, lap.car_id)
    return views.lap_json(lap, store, ref, True)


class LapPatch(BaseModel):
    valid_override: bool | None = None
    pinned_reference: bool | None = None
    model_config = {"extra": "forbid"}


@router.patch("/laps/{lap_id}")
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


@router.get("/laps/{lap_id}/trace")
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
    sid = ref_id[len(views.IDEAL_PREFIX):]
    if sid != lap.session_id:
        raise ApiError("unknown_lap", f"The ideal lap {ref_id} is not this lap's session's.")
    s = need_session(store, sid)
    tmap = need_map(store, settings, s.track_id)
    return session_pairs(store, sid), tmap


@router.get("/compare")
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


@router.get("/laps/{lap_id}/compare-candidates")
def compare_candidates(lap_id: str, store: Store, settings: Cfg) -> list[dict[str, Any]]:
    lap = need_lap(store, lap_id)
    sess = {s.session_id: s for s in store.sessions()}
    ref = store.reference_for(lap.track_id, lap.car_id)
    out: list[dict[str, Any]] = []
    try:
        pool = [
            p for p in session_pairs(store, lap.session_id) if p[0].lap_time_s
        ]  # noqa: E501
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


@router.get("/tracks/{track_id}/map")
def track_map(track_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    return need_map(store, settings, track_id).model_dump(mode="json")


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


@router.post("/tracks/{track_id}/landmarks")
def add_landmark(track_id: str, new: NewLandmark, store: Store, settings: Cfg) -> dict[str, Any]:
    m = need_map(store, settings, track_id)
    lm = Landmark(id=f"lm-{uuid.uuid4().hex[:8]}", confidence="confirmed", **new.model_dump())
    m = m.model_copy(update={"landmarks": [*m.landmarks, lm]})
    save_map(settings.tracks_dir, m)
    return m.model_dump(mode="json")


@router.patch("/tracks/{track_id}/landmarks/{landmark_id}")
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


@router.delete("/tracks/{track_id}/landmarks/{landmark_id}")
def delete_landmark(
    track_id: str, landmark_id: str, store: Store, settings: Cfg
) -> dict[str, Any]:
    m = need_map(store, settings, track_id)
    i = _landmark_index(m, landmark_id)
    m = m.model_copy(update={"landmarks": [lm for k, lm in enumerate(m.landmarks) if k != i]})
    save_map(settings.tracks_dir, m)
    return m.model_dump(mode="json")


@router.post("/tracks/{track_id}/calibrate")
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


@router.post("/coach")
def coach(req: CoachRequest, store: Store, settings: Cfg) -> dict[str, Any]:
    lap = need_lap(store, req.lap_id)
    if req.command != "average":
        own = req.ref_lap_id == lap.lap_id
        if req.ref_lap_id is None:
            ref = store.reference_for(lap.track_id, lap.car_id)
            own = ref is not None and ref.lap_id == lap.lap_id
        if own:
            return _no_findings(store, lap, req).model_dump(mode="json")
    result = run_coach(
        store, settings, req.command, req.lap_id, req.ref_lap_id, req.corner_id
    )
    return result.model_dump(mode="json")


@router.get("/coach/results")
def coach_results(lap: str, store: Store, ref: str | None = None) -> dict[str, Any]:
    found = store.latest_coach_results(lap, ref)
    return {c: r.model_dump(mode="json") for c, r in found.items()}


class FindingPatch(BaseModel):
    reviewed: bool


@router.patch("/coach/findings/{finding_id}")
def patch_finding(finding_id: str, patch: FindingPatch, store: Store) -> dict[str, Any]:
    try:
        result = store.set_finding_reviewed(finding_id, patch.reviewed)
    except KeyError:
        raise ApiError("unknown_finding", f"Finding {finding_id} was not found.") from None
    return next(f for f in result.findings if f.id == finding_id).model_dump(mode="json")


# --- session views -----------------------------------------------------------------------------


@router.get("/sessions/{session_id}/summary")
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


@router.get("/sessions/{session_id}/setup")
def session_setup(session_id: str, store: Store) -> dict[str, Any]:
    need_session(store, session_id)
    return {"entries": []}  # the setup is not read from the recording yet: unknown, not "none"


@router.get("/sessions/{session_id}/ideal")
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


@router.get("/sessions/{session_id}/segment-times")
def segment_times(session_id: str, store: Store, settings: Cfg) -> dict[str, Any]:
    s = need_session(store, session_id)
    tmap = need_map(store, settings, s.track_id)
    pairs = session_pairs(store, session_id)
    if not timed_laps(pairs):
        raise NoValidLaps("There is no valid timed lap in this session.")
    return views.segment_times_json(pairs, tmap)


@router.get("/sessions/{session_id}/stints")
def stints(session_id: str, store: Store) -> list[dict[str, Any]]:
    try:
        found = session_stints(store, session_id)
    except KeyError:
        raise ApiError("unknown_session", f"Session {session_id} is not in the store.") from None
    return [s.model_dump(mode="json") for s in found]


def _axles(w: dict[str, float] | None) -> dict[str, float] | None:
    if not w:
        return None
    return {"front": (w["fl"] + w["fr"]) / 2, "rear": (w["rl"] + w["rr"]) / 2}


@router.get("/sessions/{session_id}/report")
def session_report(session_id: str, store: Store) -> dict[str, Any]:
    """A first report: the per-lap series from the stint stats. The rules that find events are
    not ported to the backend yet, so `events` is empty and every category is unavailable."""
    s = need_session(store, session_id)
    stats = store.stint_stats(session_id)
    laps = []
    for m in store.laps(session_id):
        st = stats.get(m.lap_id)
        laps.append({
            "lap_id": m.lap_id, "lap_no": m.lap_no, "kind": m.kind.value,
            "lap_time_s": m.lap_time_s, "valid": m.effective_valid,
            "has_trace": store.trace_path(m.lap_id).is_file(),
            "tyre_surface_c": _axles(st and st.get("tyre_surface_c")),
            "tyre_carcass_c": _axles(st and st.get("tyre_carcass_c")),
            "tyre_pressure_kpa": _axles(st and st.get("tyre_pressure_kpa")),
            "brake_c": _axles(st and st.get("brake_c")),
            "track_temp_c": st.get("track_temp_c") if st else None,
            "fuel_end_l": st.get("fuel_end_l") if st else None,
            "energy_end_pct": st.get("energy_end_pct") if st else None,
            "settings": None,
        })  # fmt: skip
    reason = "The report's rules are not built in the backend yet."
    return {
        "session_id": session_id, "car_class": s.car_class, "compound": "dry",
        "laps": laps, "events": [], "windows": [],
        "unavailable": [
            {"category": c, "reason": reason}
            for c in ("tyres", "brakes", "driving", "settings", "pace", "conditions")
        ],
    }  # fmt: skip


# --- import and usage --------------------------------------------------------------------------


class ImportRequest(BaseModel):
    path: str


@router.post("/import")
def import_recording(req: ImportRequest, store: Store, settings: Cfg) -> dict[str, Any]:
    path = Path(req.path).expanduser()
    if not path.is_file():
        raise ApiError("file_not_found", f"{req.path} is not a file.")
    try:
        res = import_file(store, path, settings.raw_dir, LapSource.IMPORTED_FILE)
    except Exception as e:  # a corrupt, locked or foreign file: report it, do not crash
        raise ApiError("import_failed", f"The recording could not be imported: {e}") from e
    return {"session_id": res.session_id, "n_laps": res.lap_count, "skipped": not res.imported}


@router.get("/llm/usage")
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
