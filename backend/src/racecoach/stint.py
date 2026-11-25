"""Per-lap stint stats (fuel, virtual energy, tyres, brakes, weather) and the stints endpoint.

Ports `tools/extract-stint.py` (vroom-pnw.26). Wheel order is FL, FR, RL, RR. The stats are
computed once at import (`compute_stint_stats`), stored per lap, and `session_stints` splits the
laps into stints after each in lap, in the shape of `Stint` in `frontend/src/api/types.ts`.
The fall-off fields stay null here: vroom-9ki.20 computes them.
"""

from __future__ import annotations

from typing import Any

import numpy as np
from pydantic import BaseModel

from racecoach.model import Channel, LapKind, LapMeta, RawSession
from racecoach.store import AppStore

WHEELS = ("fl", "fr", "rl", "rr")
STINT_CHANNELS = (
    "fuel", "tyre_wear", "tyre_pressure", "tyre_carcass", "brake_temp", "track_temp", "air_temp",
    "tyre_temp_left", "tyre_temp_centre", "tyre_temp_right",
)  # fmt: skip
LAST_SAMPLE_S = 0.11  # the last 10 Hz sample before the line


class Wheels(BaseModel):
    fl: float
    fr: float
    rl: float
    rr: float


class TyreZones(BaseModel):
    left: Wheels
    centre: Wheels
    right: Wheels


class StintLap(BaseModel):
    lap_id: str
    lap_no: int
    kind: LapKind
    lap_time_s: float | None
    valid: bool
    fuel_start_l: float
    fuel_end_l: float
    energy_start_pct: float | None
    energy_end_pct: float | None
    tyre_surface_c: Wheels
    tyre_zones_c: TyreZones
    tyre_carcass_c: Wheels
    tyre_pressure_kpa: Wheels
    tyre_wear_end_pct: Wheels
    brake_c: Wheels
    track_temp_c: float
    air_temp_c: float


class StintFalloff(BaseModel):
    slope_s_per_lap: float
    n_laps: int


class Stint(BaseModel):
    stint_no: int
    laps: list[StintLap]
    falloff: StintFalloff | None = None
    falloff_fuel_corrected: dict[str, Any] | None = None  # vroom-9ki.20


def _at(ch: Channel, t: float) -> np.ndarray | float:
    """The last sample at or before `t` (the first one before the recording starts)."""
    i = int(np.clip(np.searchsorted(ch.t, t, side="right") - 1, 0, len(ch.t) - 1))
    return ch.v[i]


def _mean(ch: Channel, a: float, b: float) -> np.ndarray | None:
    i, j = np.searchsorted(ch.t, [a, b], side="left")
    return ch.v[i:j].mean(axis=0) if j > i else None


def _wheels(vals: Any, nd: int = 1) -> dict[str, float] | None:
    if vals is None:
        return None
    return {w: round(float(v), nd) for w, v in zip(WHEELS, vals, strict=True)}


def _lap_bounds(raw: RawSession) -> dict[int, tuple[float, float, bool]]:
    """lap_no -> (start, end, closed) from the `Lap` events; the last lap ends with the file."""
    lap_ev = raw.events["lap"]
    end = float(raw.channels["speed_kmh"].t[-1])
    n = len(lap_ev.t)
    return {
        int(lap_ev.v[k]): (
            float(lap_ev.t[k]), float(lap_ev.t[k + 1]) if k + 1 < n else end, k + 1 < n
        )
        for k in range(n)
    }  # fmt: skip


def compute_stint_stats(raw: RawSession, laps: list[LapMeta]) -> dict[str, dict[str, Any]]:
    """lap_id -> the stored stats (a `StintLap` without lap_id and lap_no).

    Empty when the recording lacks a stint channel. `kind` and the lap set come from `laps`
    (`build_laps`); the lap boundaries are the `Lap` events, as in the extract tool.
    """
    ch = raw.channels
    if "lap" not in raw.events or "speed_kmh" not in ch or any(n not in ch for n in STINT_CHANNELS):
        return {}
    lap_times = raw.events.get("lap_time")
    energy = ch.get("energy")
    has_energy = energy is not None and len(energy.v) > 0 and float(np.max(energy.v)) > 0
    zones = (ch["tyre_temp_left"], ch["tyre_temp_centre"], ch["tyre_temp_right"])
    bounds = _lap_bounds(raw)
    first_lap = int(raw.events["lap"].v[0])
    out: dict[str, dict[str, Any]] = {}
    for lap in laps:
        if lap.lap_no not in bounds:
            continue
        a, b, closed = bounds[lap.lap_no]
        official: float | None = None
        if closed and lap_times is not None and len(lap_times.t):
            near = np.flatnonzero(np.abs(lap_times.t - b) < 0.05)
            if len(near):
                official = float(lap_times.v[near[0]])
        e = b - LAST_SAMPLE_S
        means = [_mean(z, a, b) for z in zones]
        if any(m is None for m in means):
            continue
        left, centre, right = (np.asarray(m) for m in means)
        surface = (left + centre + right) / 3
        out[lap.lap_id] = {
            # the recording's first lap is the out lap (or a race start lap) in the stint view,
            # even when `build_laps` times it from the line
            "kind": LapKind.OUT.value if lap.lap_no == first_lap else lap.kind.value,
            "lap_time_s": None if official is None else round(official, 3),
            "valid": bool(official),
            "fuel_start_l": round(float(_at(ch["fuel"], a)), 2),
            "fuel_end_l": round(float(_at(ch["fuel"], e)), 2),
            "energy_start_pct": round(float(_at(energy, a)), 2) if has_energy and energy else None,
            "energy_end_pct": round(float(_at(energy, e)), 2) if has_energy and energy else None,
            "tyre_surface_c": _wheels(surface),
            "tyre_zones_c": {
                "left": _wheels(left),
                "centre": _wheels(centre),
                "right": _wheels(right),
            },  # fmt: skip
            "tyre_carcass_c": _wheels(_mean(ch["tyre_carcass"], a, b)),
            "tyre_pressure_kpa": _wheels(_mean(ch["tyre_pressure"], a, b)),
            "tyre_wear_end_pct": _wheels(_at(ch["tyre_wear"], e), 2),
            "brake_c": _wheels(_mean(ch["brake_temp"], a, b), 0),
            "track_temp_c": round(float(_at(ch["track_temp"], a)), 1),
            "air_temp_c": round(float(_at(ch["air_temp"], a)), 1),
        }
    return out


def split_stints(laps: list[StintLap]) -> list[Stint]:
    """Split after each in lap: the next lap (an out lap) starts the next stint."""
    stints: list[Stint] = []
    cur: list[StintLap] = []
    for lap in laps:
        cur.append(lap)
        if lap.kind == LapKind.IN:
            stints.append(Stint(stint_no=len(stints) + 1, laps=cur))
            cur = []
    if cur:
        stints.append(Stint(stint_no=len(stints) + 1, laps=cur))
    return stints


def session_stints(store: AppStore, session_id: str) -> list[Stint]:
    """`GET /sessions/{id}/stints`: the session's stints, [] when it has no stint stats.

    Raises `KeyError` for an unknown session.
    """
    if not store.has_session(session_id):
        raise KeyError(session_id)
    stats = store.stint_stats(session_id)
    rows = [
        StintLap(lap_id=lap.lap_id, lap_no=lap.lap_no, **stats[lap.lap_id])
        for lap in store.laps(session_id)
        if lap.lap_id in stats
    ]
    return split_stints(rows)
