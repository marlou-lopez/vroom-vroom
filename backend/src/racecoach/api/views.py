"""Domain objects to the JSON shapes of `frontend/src/api/types.ts`, and the compare maths."""

from __future__ import annotations

import math
from dataclasses import asdict
from typing import Any

import numpy as np

from racecoach.analysis.balance import LapBalance, compare_balance
from racecoach.analysis.consistency import (
    LapPair,
    ideal_lap,
    map_segments,
    segment_durations,
)
from racecoach.analysis.delta import corner_delta, delta_time
from racecoach.analysis.metrics import SideMetrics, corner_side
from racecoach.model import GRID_CHANNELS, LapMeta, LapTrace, SessionMeta
from racecoach.store import AppStore
from racecoach.tracks import TrackMap

IDEAL_PREFIX = "ideal:"
LATLON = ("lat", "lon")


def num(x: float | None, nd: int = 3) -> float | None:
    """Round, and turn NaN and infinity (not JSON) into None."""
    if x is None or not math.isfinite(x):
        return None
    return round(float(x), nd)


def series(arr: np.ndarray, nd: int = 3) -> list[float]:
    a = np.nan_to_num(np.asarray(arr, dtype=float), nan=0.0, posinf=0.0, neginf=0.0)
    return np.round(a, nd).tolist()


def session_json(s: SessionMeta) -> dict[str, Any]:
    d = asdict(s)
    d["started_at"] = s.started_at.isoformat()
    d["car_dims"] = None  # no source for car sizes in the backend yet
    return d


def lap_json(
    lap: LapMeta, store: AppStore, ref: LapMeta | None = None, with_ref: bool = False
) -> dict[str, Any]:
    d = asdict(lap)
    d.pop("conditions", None)
    d["kind"] = lap.kind.value
    d["source"] = lap.source.value
    d["sectors_s"] = list(lap.sectors_s)
    d["has_trace"] = store.trace_path(lap.lap_id).is_file()
    if with_ref:
        d["is_reference"] = ref is not None and ref.lap_id == lap.lap_id
    return d


def channels_json(trace: LapTrace, n: int, only: list[str] | None = None) -> dict[str, list[float]]:
    out: dict[str, list[float]] = {}
    for name in only or GRID_CHANNELS:
        arr = trace.ch.get(name)
        out[name] = series(arr[:n] if arr is not None else np.zeros(n), 7 if name in LATLON else 3)
    return out


def side_json(m: SideMetrics) -> dict[str, Any]:
    return {
        "brake_onset_m": m.brake_onset_m, "peak_brake": m.peak_brake,
        "min_speed_kmh": m.min_speed_kmh, "min_speed_m": m.min_speed_m,
        "throttle_pickup_m": m.throttle_pickup_m, "exit_speed_kmh": m.exit_speed_kmh,
        "coast_s": m.coast_s, "overlap_s": m.overlap_s, "steer_corrections": m.steer_corrections,
        "understeer_peak_deg_s": m.understeer_peak_deg_s,
        "understeer_mean_deg_s": m.understeer_mean_deg_s,
    }  # fmt: skip


def _runs(b: LapBalance | None, over: bool = False) -> list[dict[str, int]]:
    if b is None:
        return []
    runs = b.oversteer_runs if over else b.understeer_runs
    return [{"start_m": int(a), "end_m": int(b)} for a, b in runs]


def stitch_ideal(
    session_laps: list[LapPair], tmap: TrackMap, lap: LapPair
) -> tuple[LapTrace, list[int], float]:
    """The session's ideal lap as a trace (vroom-bi4.3): grid = the shortest source trace, each
    map segment takes every channel from the lap that holds its best time, `t` is re-based per
    segment and lasts `best_s`, then the whole is shifted so that its end sits as far from the
    lap's end as the lap time is from the ideal time. Returns (trace, joins_m, ideal time).
    Raises NoValidLaps."""
    ideal = ideal_lap(session_laps, tmap, "session")
    by_id = {m.lap_id: tr for m, tr in session_laps}
    segs = map_segments(tmap)
    sources = [by_id[s.lap_id] for s in ideal.segments]
    n = min(len(tr.distance) for tr in sources)
    names = [c for c in GRID_CHANNELS if all(c in tr.ch for tr in sources)]
    out = {c: np.zeros(n) for c in names}
    t = np.zeros(n)
    base = 0.0
    joins: list[int] = []
    for k, (seg, ideal_seg, src) in enumerate(zip(segs, ideal.segments, sources, strict=True)):
        a = min(round(seg.start_m), n - 1)
        b = n if k == len(segs) - 1 else min(round(seg.end_m), n)
        if k > 0:
            joins.append(a)
        if b <= a:
            base += ideal_seg.best_s
            continue
        st = np.asarray(src.ch["t"], dtype=float)
        e = min(round(seg.end_m), len(st) - 1)
        span = float(st[e] - st[a])
        scale = ideal_seg.best_s / span if span > 0 else 1.0
        t[a:b] = base + (st[a:b] - st[a]) * scale
        for c in names:
            out[c][a:b] = np.asarray(src.ch[c], dtype=float)[a:b]
        base += ideal_seg.best_s
    if t[-1] > 0:  # stretch so the clock ends at the ideal time
        t = t * (ideal.time_s / t[-1])
    # grid-end shortfall: the lap's official time minus its last grid sample (at the length the
    # two share), ramped along that length, so the delta ends at lap time minus ideal time
    meta, trace = lap
    common = min(n, len(trace.distance))
    eps = (meta.lap_time_s or 0.0) - float(trace.ch["t"][common - 1]) if meta.lap_time_s else 0.0
    t = t - eps * np.minimum(np.arange(n), common - 1) / max(common - 1, 1)
    out["t"] = t
    return LapTrace(f"{IDEAL_PREFIX}{meta.session_id}", np.arange(n, dtype=float), out), joins, (
        ideal.time_s
    )


def compare_json(
    lap: LapPair, ref: LapPair, lap_s: SessionMeta, ref_s: SessionMeta | None, tmap: TrackMap,
    *, ref_id: str, ref_kind: str, ref_car_name: str, ref_range: float | None,
    joins: list[int], warning: str | None,
) -> dict[str, Any]:  # fmt: skip
    lap_t, ref_t = lap[1], ref[1]
    n = min(len(lap_t.distance), len(ref_t.distance))
    delta = delta_time(lap_t, ref_t)
    same_car = ref_s is None or lap_s.car_id == ref_s.car_id
    bl, br = compare_balance(lap_t, ref_t, lap_s.steering_range_deg, ref_range, same_car)
    corners = []
    for c in tmap.corners:
        corners.append({
            "corner_id": c.id,
            "delta_s": round(corner_delta(delta, c), 3),
            "lap": side_json(corner_side(lap_t, c, None if bl is None else bl.balance)),
            "ref": side_json(corner_side(ref_t, c, None if br is None else br.balance)),
        })  # fmt: skip
    return {
        "lap_id": lap[0].lap_id, "ref_lap_id": ref_id,
        "lap_kind": lap[0].kind.value, "ref_kind": ref_kind,
        "distance": series(lap_t.distance[:n], 0),
        "lap": channels_json(lap_t, n), "ref": channels_json(ref_t, n),
        "delta": series(delta[:n]),
        "warning": warning,
        "lap_steering_range_deg": lap_s.steering_range_deg, "ref_steering_range_deg": ref_range,
        "lap_car_dims": None, "ref_car_dims": None,
        "lap_car_id": lap_s.car_id,
        "ref_car_id": ref_s.car_id if ref_s else lap_s.car_id,
        "lap_car_name": lap_s.car_name, "ref_car_name": ref_car_name,
        "corners": corners,
        "lap_balance": None if bl is None else bl.for_api(),
        "ref_balance": None if br is None else br.for_api(),
        "lap_understeer_runs": _runs(bl), "ref_understeer_runs": _runs(br),
        "lap_oversteer_runs": _runs(bl, True), "ref_oversteer_runs": _runs(br, True),
        "ref_joins_m": joins,
    }  # fmt: skip


def ideal_json(ideal: Any) -> dict[str, Any]:
    return {
        "time_s": ideal.time_s, "scope": ideal.scope,
        "segments": [asdict(s) for s in ideal.segments],
    }


def segment_times_json(laps: list[LapPair], tmap: TrackMap) -> dict[str, Any]:
    from racecoach.analysis.consistency import timed_laps

    segs = map_segments(tmap)
    return {
        "laps": [
            {
                "lap_id": m.lap_id, "lap_no": m.lap_no,
                "segment_s": [
                    round(d, 3) for d in segment_durations(tr, segs, m.lap_time_s or 0.0)
                ],
            }
            for m, tr in timed_laps(laps)
        ]
    }  # fmt: skip
