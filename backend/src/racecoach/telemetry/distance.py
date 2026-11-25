"""Distance fusion: a smooth, monotonic lap distance from integrated speed and `Lap Dist`."""

from __future__ import annotations

import numpy as np
from scipy.ndimage import uniform_filter1d

LINE_WINDOW_S = 3.0  # a reset of Lap Dist this close to a lap boundary belongs to the line crossing


def cumulative_trapezoid(t: np.ndarray, y: np.ndarray) -> np.ndarray:
    """Running integral of `y` over `t` (trapezoid rule), 0 at the first sample."""
    out = np.zeros(len(t))
    if len(t) > 1:
        out[1:] = np.cumsum(np.diff(t) * (y[1:] + y[:-1]) / 2)
    return out


def lap_distance_samples(
    t: np.ndarray, d: np.ndarray, track_length_m: float, t_start: float, t_end: float
) -> tuple[np.ndarray, np.ndarray, float | None]:
    """Clean one lap's `Lap Dist` samples (window `[t_start, t_end]`) into a rising distance.

    `Lap Dist` resets to 0 at the line, and the reset is not exactly on the `Lap` event: the lap's
    first samples can still read the previous lap's end and its last samples the next lap's
    start. Those are dropped. A reset in the middle of the lap (an out-lap or race start lap that
    crosses the line) keeps only what follows it, the part driven from the line on: the third
    result is the time of that first sample, else None.
    """
    half = track_length_m / 2
    t, d = np.asarray(t, float), np.asarray(d, float)
    jumps = np.nonzero(np.diff(d) < -half)[0]
    keep = np.ones(len(d), bool)
    if len(jumps) and d[0] > half and t[jumps[0]] - t_start < LINE_WINDOW_S:
        keep[: jumps[0] + 1] = False  # still the previous lap's end
        jumps = jumps[1:]
    if len(jumps) and t_end - t[jumps[-1]] < LINE_WINDOW_S:
        keep[jumps[-1] + 1 :] = False  # already the next lap's start
        jumps = jumps[:-1]
    t_cut: float | None = None
    if len(jumps):
        keep[: jumps[-1] + 1] = False
        t_cut = float(t[jumps[-1] + 1])
    return t[keep], d[keep], t_cut


def fuse_distance(
    t: np.ndarray,
    speed_ms: np.ndarray,
    lapdist_t: np.ndarray,
    lapdist_v: np.ndarray,
    track_length_m: float,
    through_origin: bool = False,
) -> np.ndarray:
    """Distance at each speed sample `t`: the integrated speed, scaled to fit `Lap Dist`.

    Integrates `speed_ms` (trapezoid), fits `lapdist ≈ a·s + b` by least squares on the
    `lapdist` samples (already cleaned, see `lap_distance_samples`) and applies it. With
    `through_origin` the lap starts on the line, so `b = 0`. The result never decreases and is
    clipped to `[0, track_length_m]`.
    """
    t = np.asarray(t, float)
    s = cumulative_trapezoid(t, np.asarray(speed_ms, float))
    a, b = 1.0, 0.0
    resid = np.zeros(len(t))
    if len(lapdist_t) >= 2 and len(t) >= 2:
        s_at = np.interp(lapdist_t, t, s)
        if through_origin:
            den = float(s_at @ s_at)
            if den > 0:
                a = float(s_at @ np.asarray(lapdist_v, float)) / den
        elif np.ptp(s_at) > 0:
            a, b = (float(x) for x in np.polyfit(s_at, lapdist_v, 1))
        # Integrated speed drifts from Lap Dist by a few metres over a lap: follow the residual
        # (smoothed over ~1 s to average out Lap Dist's 0.5 m steps).
        r = np.asarray(lapdist_v, float) - (a * s_at + b)
        k = max(1, round(1.0 / float(np.median(np.diff(lapdist_t))))) if len(r) > 1 else 1
        resid = np.interp(t, lapdist_t, uniform_filter1d(r, k, mode="nearest"))
    elif len(lapdist_t) == 1:
        b = float(lapdist_v[0] - np.interp(lapdist_t[0], t, s))
    d = np.maximum.accumulate(a * s + b + resid)
    return np.clip(d, 0.0, track_length_m)
