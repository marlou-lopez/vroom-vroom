"""Physically consistent synthetic laps for tests."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import UTC, datetime

import numpy as np

from racecoach.model import (
    GRID_CHANNELS,
    Channel,
    LapTrace,
    RawSession,
    SessionMeta,
    lap_id_for,
    slugify,
)

G = 9.81


@dataclass(frozen=True)
class SynthCorner:
    apex_m: float
    min_speed_kmh: float
    direction: int = 1  # +1 left (g_lat > 0), -1 right


def _speed_profile(
    corners: list[SynthCorner],
    n: int,
    top_kmh: float,
    brake_g: float,
    accel_g: float,
    brake_shift_m: float,
    min_speed_delta_kmh: float,
) -> np.ndarray:
    """Speed in m/s at each metre, capped by braking and acceleration envelopes (cyclic)."""
    s = np.arange(n, dtype=float)
    v = np.full(n, top_kmh / 3.6)
    a_b, a_a = brake_g * G, accel_g * G
    for c in corners:
        vmin = (c.min_speed_kmh + min_speed_delta_kmh) / 3.6
        target = c.apex_m + brake_shift_m  # where braking ends and minimum speed is reached
        for off in (-n, 0, n):
            p, apex = target + off, c.apex_m + off
            before = np.sqrt(vmin**2 + 2 * a_b * np.clip(p - s, 0, None))
            after = np.sqrt(vmin**2 + 2 * a_a * np.clip(s - apex, 0, None))
            cap = np.where(s < p, before, np.where(s <= apex, vmin, after))
            # positive shift: braking ends after the apex, minimum speed at p
            cap = np.where((s >= apex) & (s < p), before, cap) if p > apex else cap
            v = np.minimum(v, cap)
    return v


def make_lap(
    corners: list[SynthCorner],
    track_length_m: int = 2000,
    top_kmh: float = 250,
    brake_g: float = 1.4,
    accel_g: float = 0.6,
    brake_shift_m: float = 0.0,
    min_speed_delta_kmh: float = 0.0,
    lap_id: str = "L1",
) -> LapTrace:
    """One lap on the 1 m grid: `t` integrates 1/v; `g_lat` is 1.5 within 20 m of an apex."""
    n = int(track_length_m)
    v = _speed_profile(corners, n, top_kmh, brake_g, accel_g, brake_shift_m, min_speed_delta_kmh)
    # time at each metre: trapezoid of 1/v
    inv = 1.0 / v
    t = np.concatenate([[0.0], np.cumsum((inv[:-1] + inv[1:]) / 2)])
    # longitudinal acceleration (m/s^2) from v^2 differences over 1 m
    v2 = v**2
    acc = np.gradient(v2) / 2.0
    brake = np.clip(-acc / (brake_g * G), 0, 1)
    brake = np.where(brake < 0.02, 0.0, brake)
    top = top_kmh / 3.6
    throttle = np.where(acc > 0.05, 1.0, np.where(v >= top - 1e-6, 1.0, np.clip(0.3 + acc, 0, 1)))
    throttle = np.where(brake > 0, 0.0, throttle)

    s = np.arange(n, dtype=float)
    g_lat = np.zeros(n)
    steering = np.zeros(n)
    for c in corners:
        d = np.abs(s - c.apex_m)
        d = np.minimum(d, n - d)
        g_lat = np.where(d <= 20, 1.5 * c.direction, g_lat)
    # steering (normalised -1..1, + = right) proportional to g_lat / v^2, left turn = negative
    steering = np.clip(-g_lat * 800.0 / np.maximum(v, 1.0) ** 2, -1, 1)
    gear = np.clip(np.floor(v * 3.6 / 40) + 1, 1, 7)
    ang = 2 * np.pi * s / n
    zeros = np.zeros(n)
    ch: dict[str, np.ndarray] = {name: zeros.copy() for name in GRID_CHANNELS}
    ch.update(
        t=t,
        speed_kmh=v * 3.6,
        throttle=throttle,
        brake=brake,
        steering=steering,
        gear=gear,
        rpm=3000 + 150 * (v * 3.6 % 40) + 40 * v,
        g_lat=g_lat,
        g_long=-acc / G,
        yaw_rate=-g_lat * G / np.maximum(v, 1.0),
        lat=60 + 0.001 * np.sin(ang),
        lon=0.001 * np.cos(ang),
        track_edge=np.full(n, 6.0),
        slip_fl=np.ones(n),
        slip_fr=np.ones(n),
        slip_rl=np.ones(n),
        slip_rr=np.ones(n),
    )
    # sign convention: g_long > 0 is braking
    return LapTrace(lap_id=lap_id, distance=s, ch=ch)


def _segment(lap: LapTrace, start_m: float, end_m: float) -> tuple[np.ndarray, np.ndarray]:
    """Distance and time within a lap between two distances (time from 0 at start_m)."""
    t = lap.ch["t"]
    lap_time = t[-1] + 1.0 / (lap.ch["speed_kmh"][-1] / 3.6)  # closing metre back to the line
    d_all = np.append(lap.distance, lap.distance[-1] + 1.0)
    t_all = np.append(t, lap_time)
    t0 = float(np.interp(start_m, d_all, t_all))
    t1 = float(np.interp(end_m, d_all, t_all))
    return np.array([start_m, end_m]), np.array([t0, t1])


def make_raw_session(
    n_laps: int,
    corners: list[SynthCorner],
    track_length_m: int = 2000,
    lap_time_jitter_s: float = 0.0,
    invalid_laps: tuple[int, ...] = (),
    pit_exit_fraction: float = 0.3,
    **lap_kwargs: float,
) -> RawSession:
    """Out-lap from the pit exit, `n_laps` flying laps, then an in-lap, in LMU's recording format.

    `Ground Speed` (km/h) runs at 100 Hz and `Lap Dist` (m, quantised to 0.5) at 50 Hz. Events
    `Lap` (lap number at each line crossing, lap 0 = out-lap), `Lap Time` (previous lap's time at
    each lap start, 0 = invalid, none for the out-lap) and `In Pits` (1 at the start, 0 at pit
    exit, 1 at pit entry).
    """
    n = int(track_length_m)
    lap = make_lap(corners, track_length_m=n, **lap_kwargs)  # pyright: ignore[reportArgumentType]
    v_ms = lap.ch["speed_kmh"] / 3.6
    full_time = float(lap.ch["t"][-1] + 1.0 / v_ms[-1])
    start_m = pit_exit_fraction * n
    in_end_m = 0.7 * n

    # lap segments: (lap_no, start_m, end_m, duration_s)
    segs: list[tuple[int, float, float, float]] = []

    def dur(a: float, b: float) -> float:
        _, tt = _segment(lap, a, b)
        return float(tt[1] - tt[0])

    segs.append((0, start_m, float(n), dur(start_m, n)))
    for k in range(1, n_laps + 1):
        extra = lap_time_jitter_s * ((k % 3) - 1)
        segs.append((k, 0.0, float(n), full_time + extra))
    segs.append((n_laps + 1, 0.0, in_end_m, dur(0.0, in_end_m)))

    d_all = np.append(lap.distance, float(n))
    t_all = np.append(lap.ch["t"], full_time)
    dists: list[tuple[np.ndarray, np.ndarray]] = []
    speeds: list[tuple[np.ndarray, np.ndarray]] = []
    lap_events: list[tuple[float, float]] = []
    laptime_events: list[tuple[float, float]] = []
    t_cursor = 0.0
    pit_exit_t = 0.0
    prev_time: float | None = None
    for lap_no, a, b, d in segs:
        lap_events.append((t_cursor, float(lap_no)))
        if lap_no >= 2:
            invalid = (lap_no - 1) in invalid_laps
            laptime_events.append((t_cursor, 0.0 if invalid else prev_time or 0.0))
        # the segment's own time axis: scale the lap profile to this segment's duration
        t_lap_a = float(np.interp(a, d_all, t_all))
        t_lap_b = float(np.interp(b, d_all, t_all))
        scale = d / (t_lap_b - t_lap_a)
        for rate, store_d, store_v in ((100, False, True), (50, True, False)):
            ts = np.arange(0.0, d, 1.0 / rate)
            tl = t_lap_a + ts / scale
            dist = np.interp(tl, t_all, d_all)
            if store_d:
                dists.append((t_cursor + ts, np.round(dist * 2) / 2))
            if store_v:
                speeds.append((t_cursor + ts, np.interp(dist, lap.distance, lap.ch["speed_kmh"])))
        if lap_no == 0:
            pit_exit_t = t_cursor
        prev_time = d
        t_cursor += d
    pit_entry_t = t_cursor

    def cat(parts: list[tuple[np.ndarray, np.ndarray]]) -> Channel:
        return Channel(np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts]))

    def ev(rows: list[tuple[float, float]]) -> Channel:
        return Channel(np.array([r[0] for r in rows]), np.array([r[1] for r in rows]))

    sha = hashlib.sha1(f"synthetic-{n_laps}-{n}".encode()).hexdigest()
    meta = SessionMeta(
        session_id=sha,
        track_name="Synth Ring",
        track_layout="GP",
        track_id=slugify("Synth Ring GP"),
        track_length_m=float(n),
        car_name="Synth GT3 #1",
        car_id="synth-gt3",
        car_class="GT3",
        session_type="Practice",
        game_build="synthetic",
        started_at=datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
        driver="Test Driver",
        steering_range_deg=524.0,
    )
    return RawSession(
        meta=meta,
        channels={"Ground Speed": cat(speeds), "Lap Dist": cat(dists)},
        events={
            "Lap": ev(lap_events),
            "Lap Time": ev(laptime_events),
            "In Pits": ev([(0.0, 1.0), (pit_exit_t + 0.0 + 1.0, 0.0), (pit_entry_t, 1.0)]),
        },
    )


__all__ = ["SynthCorner", "lap_id_for", "make_lap", "make_raw_session"]
