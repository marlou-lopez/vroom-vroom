"""Time delta between a lap and a reference on the 1 m grid, and corner geometry helpers."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from racecoach.model import LapTrace
from racecoach.tracks import Corner


def delta_time(lap: LapTrace, ref: LapTrace) -> np.ndarray:
    """Seconds the lap is behind the reference at each grid metre (positive = lost).

    Both laps start at t = 0 on the line, so the delta is zero at metre 0.
    """
    n = min(len(lap.ch["t"]), len(ref.ch["t"]))
    return np.asarray(lap.ch["t"][:n], dtype=float) - np.asarray(ref.ch["t"][:n], dtype=float)


@dataclass(frozen=True)
class Walk:
    """The grid indices of a corner in driving order. A corner whose start is after its end
    wraps over the start line: the walk runs to the last index and continues at 0, and `u`
    keeps growing across the line."""

    idx: np.ndarray  # grid indices
    u: np.ndarray  # unwrapped position along the corner's own run, metres
    wraps_at: int | None  # position in `idx` of the first index after the wrap, if any

    def __len__(self) -> int:
        return len(self.idx)


def corner_walk(corner: Corner, n: int) -> Walk:
    last = n - 1
    s = min(round(corner.start_m), last)
    e = min(round(corner.end_m), last)
    if s <= e:
        idx = np.arange(s, e + 1)
        return Walk(idx, idx.astype(float), None)
    first = np.arange(s, last + 1)
    second = np.arange(0, e + 1)
    return Walk(
        np.concatenate([first, second]),
        np.concatenate([first, second + last]).astype(float),
        len(first),
    )


def apex_position(corner: Corner, n: int) -> float:
    """The corner's apex on its walk's unwrapped axis."""
    wraps = corner.start_m > corner.end_m
    if wraps and corner.apex_m <= corner.end_m:
        return corner.apex_m + (n - 1)
    return corner.apex_m


def walk_cumulative(series: np.ndarray, walk: Walk) -> np.ndarray:
    """Change of `series` since the walk's start at each walk position. The step over the
    start line (last index to 0) counts as zero, so the total is the series' change within
    the corner (the closing metre belongs to no corner)."""
    vals = series[walk.idx]
    steps = np.diff(vals, prepend=vals[0])
    if walk.wraps_at is not None:
        steps[walk.wraps_at] = 0.0
    return np.cumsum(steps)


def corner_delta(delta: np.ndarray, corner: Corner) -> float:
    """Lap minus reference across the corner, positive = time lost."""
    return float(walk_cumulative(delta, corner_walk(corner, len(delta)))[-1])


def span_delta(delta: np.ndarray, start: int, end: int) -> float:
    """Change of the delta between two grid indices of one run (start <= end)."""
    return float(delta[end] - delta[start])
