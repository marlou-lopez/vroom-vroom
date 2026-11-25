"""Per-lap stint stats (fuel, virtual energy, tyres, brakes, weather) and the stints endpoint.

Ports `tools/extract-stint.py` (vroom-pnw.26). Wheel order is FL, FR, RL, RR. The stats are
computed once at import (`compute_stint_stats`), stored per lap, and `session_stints` splits the
laps into stints after each in lap, in the shape of `Stint` in `frontend/src/api/types.ts`.
The raw and fuel-corrected fall-off (vroom-9ki.20) are computed on read from the stored laps, a
port of `frontend/src/lib/stint.ts`; the fuel-weight constant per car class is in
`config/cars.yaml`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from pydantic import BaseModel, ValidationError

from racecoach.lmu.reader import load_cars_config
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


class FuelAssumption(BaseModel):
    kg_per_l: float
    lap_fraction_per_kg: float
    source: str


class StintFalloffFuelCorrected(BaseModel):
    slope_s_per_lap: float
    fuel_gain_s_per_lap: float
    kg_per_lap: float
    s_per_kg: float
    assumption: FuelAssumption


class Stint(BaseModel):
    stint_no: int
    laps: list[StintLap]
    falloff: StintFalloff | None = None
    falloff_fuel_corrected: StintFalloffFuelCorrected | None = None


# ---- Fall-off (port of frontend/src/lib/stint.ts, spike vroom-d4g) ----

SLOW_LAP_FACTOR = 1.02  # a lap slower than this multiple of the median clean lap is left out
MIN_FIT_LAPS = 3


def _median(xs: list[float]) -> float:
    return float(np.median(xs))


def _fitted(laps: list[StintLap]) -> list[StintLap]:
    """The laps in the fit: flying, valid, timed, not slower than 1.02 x the median clean lap.

    Out, in and incomplete laps are left out by kind, invalid ones by their time of 0.
    """
    clean = [lap for lap in laps if lap.kind == LapKind.FLYING and lap.valid and lap.lap_time_s]
    cut = _median([lap.lap_time_s for lap in clean]) * SLOW_LAP_FACTOR if clean else float("inf")  # type: ignore[misc]
    return [
        lap
        for lap in laps
        if lap.kind == LapKind.FLYING and lap.valid and lap.lap_time_s and lap.lap_time_s <= cut
    ]


def _fit_slope(pts: list[tuple[float, float]]) -> float | None:
    """Least-squares slope of y on x; None with fewer than 3 points or no spread in x."""
    if len(pts) < MIN_FIT_LAPS:
        return None
    x = np.array([p[0] for p in pts])
    y = np.array([p[1] for p in pts])
    sxx = float(((x - x.mean()) ** 2).sum())
    if sxx == 0:
        return None
    return float(((x - x.mean()) * (y - y.mean())).sum() / sxx)


def _used(start: float, end: float) -> float | None:
    """Litres used on a lap; None when the tank was filled during it."""
    return None if end > start else start - end


def _burnt_before_midlap(laps: list[StintLap]) -> dict[int, float]:
    """lap_no -> litres burnt from the stint's start fuel to the lap's middle.

    From fuel levels, as in `lib/stint.ts`, so a missing reading does not shift later laps.
    After a refuel inside the stint this goes negative (the car is heavier than at the start),
    and the correction then takes time off.
    """
    start = laps[0].fuel_start_l
    return {lap.lap_no: start - (lap.fuel_start_l + lap.fuel_end_l) / 2 for lap in laps}


def stint_falloffs(
    laps: list[StintLap], effect: dict[str, Any] | None
) -> tuple[StintFalloff | None, StintFalloffFuelCorrected | None]:
    """The raw and fuel-corrected fall-off of one stint.

    `effect` is the car class's entry in `config/cars.yaml` (`kg_per_l`, `lap_fraction_per_kg`,
    `source`); None gives no corrected fall-off. The correction adds back to each fitted lap
    what the fuel burnt since the stint's start would have gained: s/kg x kg/L x litres burnt
    to mid-lap, with s/kg = lap_fraction_per_kg x the median fitted lap time.
    """
    fit = _fitted(laps)
    raw_slope = _fit_slope([(lap.lap_no, lap.lap_time_s) for lap in fit])  # type: ignore[misc]
    if raw_slope is None:
        return None, None
    raw = StintFalloff(slope_s_per_lap=raw_slope, n_laps=len(fit))
    if not effect:
        return raw, None
    kg_per_l = float(effect["kg_per_l"])
    fraction = float(effect["lap_fraction_per_kg"])
    sec_per_kg = fraction * _median([lap.lap_time_s for lap in fit])  # type: ignore[misc]
    burnt = _burnt_before_midlap(laps)
    slope = _fit_slope(
        [(lap.lap_no, lap.lap_time_s + sec_per_kg * kg_per_l * burnt[lap.lap_no]) for lap in fit]  # type: ignore[operator]
    )
    if slope is None:
        return raw, None
    used = [u for lap in fit if (u := _used(lap.fuel_start_l, lap.fuel_end_l)) is not None]
    kg_per_lap = sum(used) / len(used) * kg_per_l if used else 0.0
    corrected = StintFalloffFuelCorrected(
        slope_s_per_lap=slope,
        fuel_gain_s_per_lap=sec_per_kg * kg_per_lap,
        kg_per_lap=kg_per_lap,
        s_per_kg=sec_per_kg,
        assumption=FuelAssumption(
            kg_per_l=kg_per_l, lap_fraction_per_kg=fraction, source=str(effect["source"])
        ),
    )
    return raw, corrected


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


def split_stints(laps: list[StintLap], effect: dict[str, Any] | None = None) -> list[Stint]:
    """Split after each in lap: the next lap (an out lap) starts the next stint.

    Each stint carries its fall-off; `effect` is the car class's fuel constant (see
    `stint_falloffs`).
    """
    stints: list[Stint] = []

    def add(cur: list[StintLap]) -> None:
        raw, corrected = stint_falloffs(cur, effect)
        stints.append(
            Stint(
                stint_no=len(stints) + 1,
                laps=cur,
                falloff=raw,
                falloff_fuel_corrected=corrected,
            )
        )

    cur: list[StintLap] = []
    for lap in laps:
        cur.append(lap)
        if lap.kind == LapKind.IN:
            add(cur)
            cur = []
    if cur:
        add(cur)
    return stints


def fuel_effect_for(car_class: str, cars_config: Path | str | None = None) -> dict[str, Any] | None:
    """The fuel-weight constant of a car class from `config/cars.yaml` (`fuel_effect`), or None."""
    return (load_cars_config(cars_config).get("fuel_effect") or {}).get(car_class)


def session_stints(
    store: AppStore, session_id: str, cars_config: Path | str | None = None
) -> list[Stint]:
    """`GET /sessions/{id}/stints`: the session's stints, [] when it has no stint stats.

    Raises `KeyError` for an unknown session.
    """
    if not store.has_session(session_id):
        raise KeyError(session_id)
    stats = store.stint_stats(session_id)
    rows: list[StintLap] = []
    for lap in store.laps(session_id):
        if lap.lap_id not in stats:
            continue
        try:
            rows.append(StintLap(lap_id=lap.lap_id, lap_no=lap.lap_no, **stats[lap.lap_id]))
        except ValidationError:  # a short lap with no samples of a channel: left out
            continue
    car_class = next(m.car_class for m in store.sessions() if m.session_id == session_id)
    return split_stints(rows, fuel_effect_for(car_class, cars_config))


# ---- Coach facts ----


@dataclass(frozen=True)
class StintFacts:
    """What the coach may say about one stint's fall-off. Numbers are rounded as they may be
    quoted: the LLM only phrases them. `fuel_corrected_s_per_lap` is None for a car class
    without a constant, and `assumption` then is None too."""

    stint_no: int
    n_laps: int
    raw_s_per_lap: float
    fuel_corrected_s_per_lap: float | None
    fuel_gain_s_per_lap: float | None
    assumption: str | None


def stint_facts(stints: list[Stint]) -> list[StintFacts]:
    """Fall-off facts of the stints that have a fit (3 or more fitted laps)."""
    out: list[StintFacts] = []
    for s in stints:
        if s.falloff is None:
            continue
        c = s.falloff_fuel_corrected
        a = c.assumption if c else None
        out.append(
            StintFacts(
                stint_no=s.stint_no,
                n_laps=s.falloff.n_laps,
                raw_s_per_lap=round(s.falloff.slope_s_per_lap, 3),
                fuel_corrected_s_per_lap=round(c.slope_s_per_lap, 3) if c else None,
                fuel_gain_s_per_lap=round(c.fuel_gain_s_per_lap, 3) if c else None,
                assumption=(
                    f"{a.source}: {a.lap_fraction_per_kg * 100:.2f} % of the lap per kg, "
                    f"{a.kg_per_l} kg/L; an assumption, not measured"
                )
                if a
                else None,
            )
        )
    return out
