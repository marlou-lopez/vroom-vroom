"""Split an LMU `RawSession` into laps and put each on the 1 m distance grid."""

from __future__ import annotations

import numpy as np

from racecoach.model import (
    Channel,
    LapKind,
    LapMeta,
    LapSource,
    LapTrace,
    RawSession,
    lap_id_for,
)
from racecoach.telemetry.distance import fuse_distance, lap_distance_samples
from racecoach.telemetry.resample import step_at, to_distance_grid

EVENT_MATCH_S = 0.25  # Lap Time and sector events share the next lap's start `ts`
MIN_GEAR_S = 0.2  # a Gear 0 shorter than this is the gearbox between two gears, not neutral
OFF_TRACK_SURFACES = (2, 4)  # grass, gravel; kerbs (5, 6) count as on track
KERB_SURFACES = (5, 6)
PASS_THROUGH = (
    "speed_kmh", "throttle", "brake", "steering", "rpm", "g_lat", "g_long", "lat", "lon",
    "path_lateral", "track_edge", "tc",
)  # fmt: skip
WHEELS = ("fl", "fr", "rl", "rr")
MIN_SLIP_SPEED_MS = 5.0


def drop_gear_blips(gear: Channel, min_s: float = MIN_GEAR_S) -> Channel:
    """Remove `Gear 0` events that last less than `min_s`, so the previous gear holds."""
    if len(gear.t) < 2:
        return gear
    lasts = np.append(np.diff(gear.t), np.inf)
    keep = ~((gear.v == 0) & (lasts < min_s))
    return Channel(gear.t[keep], gear.v[keep])


def _event_near(ev: Channel | None, t: float) -> float | None:
    """Value of the event closest to `t` within `EVENT_MATCH_S`, else None."""
    if ev is None or len(ev.t) == 0:
        return None
    i = int(np.argmin(np.abs(ev.t - t)))
    return float(ev.v[i]) if abs(ev.t[i] - t) <= EVENT_MATCH_S else None


def _sectors(raw: RawSession, t_end: float, lap_time: float) -> tuple[float, ...]:
    """[S1, S2 - S1, lap - S2]; Last Sector2 is cumulative. Empty unless 0 < S1 < S2 < lap."""
    s1 = _event_near(raw.events.get("last_sector1"), t_end)
    s2 = _event_near(raw.events.get("last_sector2"), t_end)
    if s1 is None or s2 is None or not 0 < s1 < s2 < lap_time:
        return ()
    return (s1, s2 - s1, lap_time - s2)


def _derived_channels(raw: RawSession) -> dict[str, Channel]:
    """Everything that goes on the grid, under its grid name."""
    ch = raw.channels
    out: dict[str, Channel] = {n: ch[n] for n in PASS_THROUGH if n in ch}
    if "gear" in raw.events:
        out["gear"] = drop_gear_blips(raw.events["gear"])
    if "abs" in raw.events:
        out["abs"] = raw.events["abs"]
    if "surface" in ch:
        s = ch["surface"]
        out["wheels_off"] = Channel(s.t, np.isin(s.v, OFF_TRACK_SURFACES).sum(axis=1).astype(float))
        out["kerb"] = Channel(s.t, np.isin(s.v, KERB_SURFACES).any(axis=1).astype(float))
    if "susp" in ch:
        for i, w in enumerate(WHEELS):
            out[f"susp_{w}"] = Channel(ch["susp"].t, ch["susp"].v[:, i])
    if "wheel_speed" in ch and "speed_kmh" in ch:
        ws, gs = ch["wheel_speed"], ch["speed_kmh"]
        ground = np.interp(ws.t, gs.t, gs.v) / 3.6
        slow = ground < MIN_SLIP_SPEED_MS
        for i, w in enumerate(WHEELS):
            ratio = np.where(slow, 1.0, ws.v[:, i] / np.where(slow, 1.0, ground))
            out[f"slip_{w}"] = Channel(ws.t, ratio)
    return out


def _conditions(raw: RawSession, t_a: float, t_b: float) -> dict[str, float]:
    ch, cond = raw.channels, {}
    for name, key in (("track_temp", "track_temp_c"), ("air_temp", "air_temp_c")):
        if name in ch:
            m = (ch[name].t >= t_a) & (ch[name].t <= t_b)
            held = step_at(ch[name], np.array([t_a]))[0]
            cond[key] = float(np.mean(ch[name].v[m]) if m.any() else held)
    wet = raw.events.get("wetness")
    if wet is not None and len(wet.t):
        # Events are emitted on change: the value held at the start, and any change inside the lap.
        inside = wet.v[(wet.t > t_a) & (wet.t <= t_b)]
        held = float(step_at(wet, np.array([t_a]))[0])
        cond["path_wetness"] = float(max(held, *inside)) if len(inside) else held
    if "fuel" in ch:
        cond["fuel_start_l"] = float(step_at(ch["fuel"], np.array([t_a]))[0])
    if "tyre_wear" in ch:
        w = ch["tyre_wear"]
        idx = int(np.clip(np.searchsorted(w.t, t_a, side="right") - 1, 0, len(w.t) - 1))
        cond["tyre_wear_pct"] = float(np.mean(w.v[idx]))
    return cond


def _state_at(ev: Channel | None, t: float) -> bool:
    """On/off state (e.g. In Pits) at `t`; before the first event, the first event's value."""
    if ev is None or len(ev.t) == 0:
        return False
    return bool(step_at(ev, np.array([t]))[0] > 0.5)


def build_laps(
    raw: RawSession, source: LapSource = LapSource.OWN_RECORDING
) -> list[tuple[LapMeta, LapTrace]]:
    """Split on the `Lap` events and resample every lap onto the 1 m grid.

    Kind: lap 0 and any lap that starts in the pits is `out`; one that ends in the pits is `in`;
    the last lap, when the recording ends before the line, is `incomplete`; the rest are `flying`.
    A flying lap has the `Lap Time` event's time, unless that is 0 (LMU's invalid flag): then the
    elapsed time and `valid=False`. Out, in and incomplete laps have no lap time.
    """
    meta = raw.meta
    lap_ev = raw.events.get("lap")
    speed, lap_dist = raw.channels.get("speed_kmh"), raw.channels.get("lap_dist")
    if lap_ev is None or speed is None or lap_dist is None or len(lap_ev.t) == 0:
        raise ValueError("recording has no lap events, speed or lap distance")
    in_pits, lap_times = raw.events.get("in_pits"), raw.events.get("lap_time")
    channels = _derived_channels(raw)
    session_end = float(speed.t[-1])
    n = len(lap_ev.t)
    out: list[tuple[LapMeta, LapTrace]] = []
    for k in range(n):
        t_a = float(lap_ev.t[k])
        closed = k + 1 < n
        t_b = float(lap_ev.t[k + 1]) if closed else session_end
        lap_no = int(lap_ev.v[k])
        sm = (speed.t >= t_a) & ((speed.t < t_b) if closed else (speed.t <= t_b))
        dm = (lap_dist.t >= t_a) & ((lap_dist.t < t_b) if closed else (lap_dist.t <= t_b))
        if sm.sum() < 2:
            continue

        starts_in_pits = _state_at(in_pits, t_a)
        entered_pits = in_pits is not None and bool(
            np.any((in_pits.t > t_a) & (in_pits.t <= t_b) & (in_pits.v > 0.5))
        )
        ends_in_pits = entered_pits or _state_at(in_pits, t_b - 0.01)
        ld_t, ld_d, t_cut = lap_distance_samples(
            lap_dist.t[dm], lap_dist.v[dm], meta.track_length_m, t_a, t_b
        )
        # lap 0 is an out-lap, unless it is a race start lap: it starts on the grid, crosses the
        # line and is timed like any other lap
        if starts_in_pits or (lap_no == 0 and t_cut is None):
            kind = LapKind.OUT
        elif ends_in_pits:
            kind = LapKind.IN
        elif not closed:
            kind = LapKind.INCOMPLETE
        else:
            kind = LapKind.FLYING
        at_line = kind != LapKind.OUT
        if t_cut is not None:  # crossed the line mid-lap: the lap proper starts there
            at_line, t_start = True, t_cut
            sm &= speed.t >= t_cut
            if sm.sum() < 2:
                continue
        else:
            t_start = t_a
        ts = speed.t[sm]
        d = fuse_distance(ts, speed.v[sm] / 3.6, ld_t, ld_d, meta.track_length_m, at_line)
        if at_line:  # the lap starts exactly on the line
            ts, d = np.concatenate([[t_start], ts]), np.concatenate([[0.0], d])
        if closed and kind == LapKind.FLYING and d[-1] < meta.track_length_m and t_b > ts[-1]:
            # Lap Dist's last sample is 1-3 m short of the line: the lap ends on it
            ts, d = np.append(ts, t_b), np.append(d, meta.track_length_m)
        try:
            trace = to_distance_grid(
                lap_id_for(meta.session_id, lap_no),
                d, ts, channels, meta.track_length_m, start_m=float(d[0]),
            )  # fmt: skip
        except ValueError:
            continue

        lap_time: float | None = None
        sectors: tuple[float, ...] = ()
        valid = kind != LapKind.INCOMPLETE
        if kind == LapKind.FLYING:
            official = _event_near(lap_times, t_b)
            if official is not None and official > 0:
                lap_time = official
                sectors = _sectors(raw, t_b, official)
            else:  # LMU flags an invalid lap with Lap Time = 0
                lap_time, valid = t_b - t_a, False
        lap = LapMeta(
            lap_id=trace.lap_id,
            session_id=meta.session_id,
            lap_no=lap_no,
            kind=kind,
            lap_time_s=lap_time,
            sectors_s=sectors,
            valid=valid,
            valid_override=None,
            pinned_reference=False,
            source=source,
            driver=meta.driver,
            track_id=meta.track_id,
            car_id=meta.car_id,
            conditions=_conditions(raw, t_a, t_b),
        )
        out.append((lap, trace))
    return out
