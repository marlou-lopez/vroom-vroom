"""Per-corner driving metrics of one lap, measured on the 1 m grid.

Definitions match the frontend contract (`CornerSideMetrics`, `frontend/src/api/types.ts`) and
its reference implementation `frontend/src/api/mock/coachFacts.ts`, so the table and the coach
agree. A corner that wraps over the start line is measured across it. Positions are grid
metres (0 = start line).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from racecoach.analysis.balance import BALANCE_MARK_DEG_S, corner_understeer
from racecoach.analysis.delta import Walk, apex_position, corner_walk
from racecoach.model import LapTrace
from racecoach.tracks import Corner

BRAKE_ONSET = 0.1
THROTTLE_PICKUP = 0.5
FULL_THROTTLE = 0.95
COAST_PEDAL = 0.05
COAST_MIN_KMH = 50.0
OVERLAP_PEDAL = 0.1
STEER_PROMINENCE = 0.1
STEER_SMOOTH_M = 5


@dataclass(frozen=True)
class SideMetrics:
    """One lap's numbers through one corner. None where the lap never does the thing."""

    brake_onset_m: int | None  # first m from corner start to apex with brake >= 0.1
    peak_brake: float
    release_point_m: int | None  # first m after the peak where the brake falls below 0.1
    trail_release_rate: float | None  # brake pressure shed per metre from the peak to the release
    min_speed_kmh: float
    min_speed_m: int
    coast_s: float
    overlap_s: float
    throttle_pickup_m: int | None  # first m from the minimum speed with throttle >= 0.5
    full_throttle_m: int | None  # first m from the minimum speed with throttle >= 0.95
    steer_corrections: int  # direction reversals of the smoothed steering
    gear_at_apex: int | None
    exit_speed_kmh: float
    understeer_peak_deg_s: float | None
    understeer_mean_deg_s: float | None
    balance_ratio: float | None  # share of the corner's metres past the understeer mark


def _smooth_walk(steering: np.ndarray, walk: Walk, wrap: bool) -> np.ndarray:
    n = len(steering)
    offs = np.arange(-STEER_SMOOTH_M, STEER_SMOOTH_M + 1)
    j = walk.idx[:, None] + offs[None, :]
    if wrap:
        return steering[j % n].mean(axis=1)
    ok = (j >= 0) & (j < n)
    return (steering[np.clip(j, 0, n - 1)] * ok).sum(axis=1) / ok.sum(axis=1)


def steering_extrema(steering: np.ndarray, corner: Corner) -> int:
    """Direction reversals of the smoothed steering (+-5 m) whose prominence is at least 10 %
    of the corner's largest smoothed steering."""
    walk = corner_walk(corner, len(steering))
    v = _smooth_walk(np.asarray(steering, dtype=float), walk, corner.start_m > corner.end_m)
    thr = STEER_PROMINENCE * float(np.abs(v).max())
    if not thr > 0:
        return 0
    direction, ext, count = 0, float(v[0]), 0
    for x in v[1:]:
        if direction == 0:
            if x - ext >= thr:
                direction, ext = 1, float(x)
            elif ext - x >= thr:
                direction, ext = -1, float(x)
        elif direction == 1:
            if x > ext:
                ext = float(x)
            elif ext - x >= thr:
                direction, ext, count = -1, float(x), count + 1
        elif x < ext:
            ext = float(x)
        elif x - ext >= thr:
            direction, ext, count = 1, float(x), count + 1
    return count


def _step_dt(t: np.ndarray) -> np.ndarray:
    """Seconds spent in each grid step; the step off the last sample reuses the one before it."""
    dt = np.diff(t, append=np.nan)
    if len(t) > 1:
        dt[-1] = t[-1] - t[-2]
    return np.nan_to_num(dt)


def corner_side(
    lap: LapTrace, corner: Corner, balance: np.ndarray | None = None
) -> SideMetrics:
    ch = lap.ch
    n = len(ch["speed_kmh"])
    walk = corner_walk(corner, n)
    idx = walk.idx
    speed = np.asarray(ch["speed_kmh"], dtype=float)
    throttle = np.asarray(ch["throttle"], dtype=float)
    brake = np.asarray(ch["brake"], dtype=float)
    w_speed, w_thr, w_brk = speed[idx], throttle[idx], brake[idx]

    min_k = int(np.argmin(w_speed))
    peak_k = int(np.argmax(w_brk))
    peak_brake = float(w_brk[peak_k])
    apex_u = apex_position(corner, n)

    before_apex = (walk.u <= apex_u) & (w_brk >= BRAKE_ONSET)
    onset_k = int(np.argmax(before_apex)) if before_apex.any() else None

    release_k: int | None = None
    trail_rate: float | None = None
    if peak_brake >= BRAKE_ONSET:
        below = np.flatnonzero(w_brk[peak_k:] < BRAKE_ONSET)
        if len(below):
            release_k = peak_k + int(below[0])
            run = float(walk.u[release_k] - walk.u[peak_k])
            trail_rate = round((peak_brake - float(w_brk[release_k])) / run, 4) if run > 0 else None

    def first_from_min(level: float) -> int | None:
        hit = np.flatnonzero(w_thr[min_k:] >= level)
        return int(idx[min_k + hit[0]]) if len(hit) else None

    # steps k -> k+1 inside the corner (the last metre has no step of its own)
    dt = _step_dt(np.asarray(ch["t"], dtype=float))[idx]
    if walk.wraps_at is not None:
        dt[walk.wraps_at - 1] = 0.0  # last index and index 0 are the same point on the line
    dt = dt[:-1]
    s, th, br = w_speed[:-1], w_thr[:-1], w_brk[:-1]
    coast = float(dt[(th < COAST_PEDAL) & (br < COAST_PEDAL) & (s > COAST_MIN_KMH)].sum())
    overlap = float(dt[(th > OVERLAP_PEDAL) & (br > OVERLAP_PEDAL)].sum())

    under = corner_understeer(balance, corner)
    ratio: float | None = None
    if balance is not None:
        vals = balance[idx]
        vals = vals[np.isfinite(vals)]
        ratio = round(float((vals > BALANCE_MARK_DEG_S).mean()), 3) if len(vals) else None

    apex_i = min(int(round(corner.apex_m)), n - 1)
    gear = int(ch["gear"][apex_i]) if "gear" in ch else None
    if gear == 0:  # the grid fills a missing gear channel with 0 (neutral): no data
        gear = None
    return SideMetrics(
        brake_onset_m=int(idx[onset_k]) if onset_k is not None else None,
        peak_brake=round(peak_brake, 3),
        release_point_m=int(idx[release_k]) if release_k is not None else None,
        trail_release_rate=trail_rate,
        min_speed_kmh=round(float(w_speed[min_k]), 1),
        min_speed_m=int(idx[min_k]),
        coast_s=round(coast, 3),
        overlap_s=round(overlap, 3),
        throttle_pickup_m=first_from_min(THROTTLE_PICKUP),
        full_throttle_m=first_from_min(FULL_THROTTLE),
        steer_corrections=steering_extrema(np.asarray(ch["steering"], dtype=float), corner),
        gear_at_apex=gear,
        exit_speed_kmh=round(float(w_speed[-1]), 1),
        understeer_peak_deg_s=under[0] if under else None,
        understeer_mean_deg_s=under[1] if under else None,
        balance_ratio=ratio,
    )
