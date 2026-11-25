"""Resample time series onto the 1 m distance grid."""

from __future__ import annotations

import numpy as np

from racecoach.model import GRID_CHANNELS, Channel, LapTrace

STEPWISE = frozenset({"gear", "kerb", "wheels_off"})  # the latest sample at or before the metre
ANY_ON = frozenset({"abs", "tc"})  # 1 if the signal is on at any moment inside the metre
DEFAULTS = {"slip_fl": 1.0, "slip_fr": 1.0, "slip_rl": 1.0, "slip_rr": 1.0}
MIN_WINDOW_S = 0.005
G = 9.81


def step_at(ch: Channel, t: np.ndarray) -> np.ndarray:
    """Step function: the latest sample at or before each `t` (the first sample before them all)."""
    idx = np.clip(np.searchsorted(ch.t, t, side="right") - 1, 0, len(ch.t) - 1)
    return np.asarray(ch.v[idx], dtype=float)


def any_on(ch: Channel, t0: np.ndarray, t1: np.ndarray, carry: bool = True) -> np.ndarray:
    """1 where the on/off signal is on at any moment in `[t0, t1)`.

    The signal holds its last value between samples, so the state carried into the window counts
    too when `carry` (ABS is an event table whose pulses last ~15 ms: never interpolate it); a
    sampled channel like TC counts only the samples inside the window.
    """
    on = np.concatenate([[0], np.cumsum(ch.v > 0.5)])  # on[i] = on-samples among the first i
    first = np.searchsorted(ch.t, t0, side="right")  # first sample strictly after t0
    last = np.searchsorted(ch.t, t1, side="left")  # samples before t1
    inside = on[np.maximum(last, first)] - on[first] > 0
    carried = carry & (first > 0) & (ch.v[np.clip(first - 1, 0, len(ch.v) - 1)] > 0.5)
    return (inside | carried).astype(float)


def to_distance_grid(
    lap_id: str,
    dist: np.ndarray,
    t: np.ndarray,
    channels: dict[str, Channel],
    length_m: float,
    start_m: float = 0.0,
) -> LapTrace:
    """Resample `channels` onto whole metres from `ceil(start_m)` to `floor(length_m)`.

    `dist` is the lap distance at each time `t` (non-decreasing); the grid never goes past the
    last distance reached. `t` in the result is seconds since `t[0]`, the lap start. Channels are
    interpolated linearly, except `STEPWISE` ones (latest sample) and `ANY_ON` ones (any on-sample
    inside the metre). A missing `yaw_rate` is derived from `g_lat` and `speed_kmh` (the path's
    yaw rate, left +); any other missing grid channel is zero (slip: 1).
    """
    dist, t = np.asarray(dist, float), np.asarray(t, float)
    rising = np.concatenate([[True], np.diff(dist) > 0])
    d_u, t_u = dist[rising], t[rising]
    if len(d_u) < 2:
        raise ValueError("lap has no distance covered")
    end = min(length_m, float(d_u[-1]))
    grid = np.arange(np.ceil(start_m), np.floor(end) + 1)
    t_of_d = np.interp(grid, d_u, t_u)
    t_next = np.maximum(np.interp(grid + 1, d_u, t_u), t_of_d + MIN_WINDOW_S)

    ch: dict[str, np.ndarray] = {"t": t_of_d - t[0]}
    for name, src in channels.items():
        if name in ANY_ON:
            ch[name] = any_on(src, t_of_d, t_next, carry=name == "abs")
        elif name in STEPWISE:
            ch[name] = step_at(src, t_of_d)
        else:
            ch[name] = np.interp(t_of_d, src.t, src.v)
    if "yaw_rate" not in ch and "g_lat" in ch and "speed_kmh" in ch:
        ch["yaw_rate"] = ch["g_lat"] * G / np.maximum(ch["speed_kmh"] / 3.6, 5.0)
    for name in GRID_CHANNELS:
        if name not in ch:
            ch[name] = np.full(len(grid), DEFAULTS.get(name, 0.0))
    return LapTrace(lap_id=lap_id, distance=grid, ch=ch)
