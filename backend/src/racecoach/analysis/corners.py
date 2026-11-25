"""Corner detection on a reference lap's 1 m grid."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.ndimage import uniform_filter1d
from scipy.signal import find_peaks

from racecoach.model import LapTrace

SMOOTH_M = 15
PROMINENCE_KMH = 8.0
FLAT_G = 1.2
FLAT_MIN_M = 40
MERGE_M = 60
LEAD_IN_M = 50
RUN_OUT_M = 100
FLAT_LEAD_M = 200
BRAKE_OFF = 0.05
FULL_THROTTLE = 0.95
LIFT_THROTTLE = 0.98
# A flat-out stretch must last this long to count as the lead-in: a brief throttle stab inside a
# braking phase (Bus Stop's chicane) is not the start of the corner.
MIN_FULL_RUN_M = 20


@dataclass(frozen=True)
class DetectedCorner:
    apex_m: float
    start_m: float
    end_m: float
    min_speed_kmh: float
    flat: bool


def _flat_zones(g_lat: np.ndarray) -> list[tuple[int, int]]:
    """Inclusive index runs where |g_lat| >= FLAT_G for at least FLAT_MIN_M metres."""
    on = np.abs(g_lat) >= FLAT_G
    padded = np.concatenate([[False], on, [False]]).astype(np.int8)
    edges = np.diff(padded)
    starts = np.flatnonzero(edges == 1)
    ends = np.flatnonzero(edges == -1) - 1
    return [(int(a), int(b)) for a, b in zip(starts, ends, strict=True) if b - a + 1 >= FLAT_MIN_M]


def _phase_start(full: np.ndarray, apex: int, floor: int) -> int | None:
    """End of the last >= MIN_FULL_RUN_M flat-out run before the apex, not before floor."""
    if full[apex]:
        return None
    i = apex - 1
    while i >= floor:
        if not full[i]:
            i -= 1
            continue
        j = i
        while j - 1 >= floor and full[j - 1]:
            j -= 1
        if i - j + 1 >= MIN_FULL_RUN_M:
            return i
        i = j - 1
    return None


def detect_corners(ref: LapTrace) -> list[DetectedCorner]:
    speed = np.asarray(ref.ch["speed_kmh"], dtype=float)
    g_lat = np.asarray(ref.ch["g_lat"], dtype=float)
    brake = np.asarray(ref.ch["brake"], dtype=float)
    throttle = np.asarray(ref.ch["throttle"], dtype=float)
    n = len(speed)
    if n < 3:
        return []

    smooth = uniform_filter1d(speed, size=SMOOTH_M, mode="nearest")
    peaks, _ = find_peaks(-smooth, prominence=PROMINENCE_KMH)
    apexes: dict[int, bool] = {int(p): False for p in peaks}
    for a, b in _flat_zones(g_lat):
        if any(a <= p <= b for p in apexes):
            continue
        apexes[a + int(np.argmax(np.abs(g_lat[a : b + 1])))] = True

    # merge apexes closer than MERGE_M, keeping the slowest (a flat one only if nothing slower)
    merged: list[int] = []
    for p in sorted(apexes):
        if merged and p - merged[-1] < MERGE_M:
            if smooth[p] < smooth[merged[-1]]:
                apexes[p] = apexes[p] and apexes[merged[-1]]
                merged[-1] = p
            else:
                apexes[merged[-1]] = apexes[merged[-1]] and apexes[p]
        else:
            merged.append(p)
    if not merged:
        return []

    full = (brake < BRAKE_OFF) & (throttle >= FULL_THROTTLE)
    starts: list[int] = []
    for i, p in enumerate(merged):
        floor = (merged[i - 1] + p) // 2 if i > 0 else 0
        phase = _phase_start(full, p, floor)
        raw = p - FLAT_LEAD_M if phase is None else phase - LEAD_IN_M
        starts.append(max(floor, raw, 0))

    out: list[DetectedCorner] = []
    for i, p in enumerate(merged):
        cap = starts[i + 1] if i + 1 < len(merged) else n - 1
        after = np.flatnonzero(throttle[p:] >= LIFT_THROTTLE)
        base = p + int(after[0]) if len(after) else p
        end = min(base + RUN_OUT_M, cap, n - 1)
        end = max(end, p)
        out.append(
            DetectedCorner(
                apex_m=float(ref.distance[p]),
                start_m=float(ref.distance[starts[i]]),
                end_m=float(ref.distance[end]),
                min_speed_kmh=float(speed[p]),
                flat=apexes[p],
            )
        )
    return out
