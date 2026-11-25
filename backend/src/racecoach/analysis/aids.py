"""Driver-aid, engine and kerb facts of one lap in one corner (port of `extrasOf` in the spike).

ABS and TC seconds, where a wheel locked (braking) or spun (a driven wheel under power), time on
the rev limiter, peak rpm, gear at the slowest point and time on a kerb. Computed in code; the
coach only phrases them. Slip channels are wheel surface speed over ground speed (1 = no slip).
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from racecoach.analysis.balance import runs_of
from racecoach.analysis.delta import corner_walk
from racecoach.model import LapTrace
from racecoach.tracks import Corner

LOCKUP_SLIP = 0.9
WHEELSPIN_SLIP = 1.1
MIN_PEDAL = 0.05
MERGE_GAP_M = 2
LIMITER_FRACTION = 0.985
DRIVEN = ("slip_rl", "slip_rr")
ALL_WHEELS = ("slip_fl", "slip_fr", "slip_rl", "slip_rr")


@dataclass(frozen=True)
class CornerAids:
    abs_s: float
    tc_s: float
    lockup_m: int | None  # first metre of the first lock-up run in the corner
    wheelspin_m: int | None
    limiter_s: float | None  # None when no rev limit is known
    peak_rpm: int
    gear_at_min_speed: int | None
    kerb_s: float


def rev_limit(*laps: LapTrace) -> float | None:
    """The highest rpm seen on the laps: the best stand-in for the limiter the recording allows
    (an assumption, there is no setup in the store). None without an rpm channel."""
    peaks = [float(np.max(lap.ch["rpm"])) for lap in laps if "rpm" in lap.ch and len(lap.ch["rpm"])]
    peak = max(peaks, default=0.0)
    return peak if peak > 0 else None


def _seconds(t: np.ndarray, idx: np.ndarray, flag: np.ndarray) -> float:
    """Time spent on grid steps k -> k+1 (k in the corner) where flag[k] holds."""
    total = 0.0
    for k in idx:
        if k + 1 < len(t) and flag[k]:
            total += float(t[k + 1] - t[k])
    return round(total, 3)


def _first_run(flag: np.ndarray, idx: np.ndarray) -> int | None:
    runs = runs_of(flag, MERGE_GAP_M)
    inside = set(int(i) for i in idx)
    for a, b in runs:
        if a in inside or b in inside:
            return a
    return None


def corner_aids(lap: LapTrace, corner: Corner, limit: float | None) -> CornerAids:
    ch = lap.ch
    n = len(ch["t"])
    idx = corner_walk(corner, n).idx
    t = np.asarray(ch["t"], dtype=float)

    def arr(name: str) -> np.ndarray:
        return np.asarray(ch[name], dtype=float) if name in ch else np.zeros(n)

    brake, throttle = arr("brake"), arr("throttle")
    speed, rpm = arr("speed_kmh"), arr("rpm")
    slip = {k: arr(k) for k in ALL_WHEELS}
    locked = (brake > MIN_PEDAL) & np.any([slip[k] < LOCKUP_SLIP for k in ALL_WHEELS], axis=0)
    spinning = (throttle > MIN_PEDAL) & np.any([slip[k] > WHEELSPIN_SLIP for k in DRIVEN], axis=0)
    min_i = int(idx[int(np.argmin(speed[idx]))])
    gear = int(ch["gear"][min_i]) if "gear" in ch else 0
    return CornerAids(
        abs_s=_seconds(t, idx, arr("abs") > 0),
        tc_s=_seconds(t, idx, arr("tc") > 0),
        lockup_m=_first_run(locked, idx),
        wheelspin_m=_first_run(spinning, idx),
        limiter_s=None if limit is None else _seconds(t, idx, rpm >= LIMITER_FRACTION * limit),
        peak_rpm=int(round(float(rpm[idx].max()))),
        gear_at_min_speed=gear or None,
        kerb_s=_seconds(t, idx, arr("kerb") > 0),
    )
