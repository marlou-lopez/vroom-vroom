"""Session consistency facts (the Average command), the ideal lap and focus tracking.

Only valid flying laps count: never invalid, out, in or incomplete laps. Everything here is
computed in code; the coach only phrases it. Segments follow the track map as it is now, so the
ideal lap is recomputed on every call and never stored.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np

from racecoach.analysis.delta import corner_walk, walk_cumulative
from racecoach.model import LapKind, LapMeta, LapTrace
from racecoach.tracks import Corner, TrackMap

MIN_LAPS = 2
FOCUS_THRESHOLD_S = 0.05

IdealScope = Literal["session", "all"]
LapPair = tuple[LapMeta, LapTrace]


class NotEnoughLaps(ValueError):
    """Fewer than 2 valid flying laps: no spread to measure."""

    code = "not_enough_laps"


class NoValidLaps(ValueError):
    """No valid flying lap in scope to build an ideal lap from."""

    code = "no_valid_laps"


def is_timed(meta: LapMeta) -> bool:
    return (
        meta.kind == LapKind.FLYING
        and meta.effective_valid
        and meta.lap_time_s is not None
        and meta.lap_time_s > 0
    )


def timed_laps(laps: list[LapPair]) -> list[LapPair]:
    return [p for p in laps if is_timed(p[0])]


def _mean_sd(xs: list[float]) -> tuple[float, float]:
    """Mean and sample standard deviation (n - 1); sd is 0 for a single value."""
    n = len(xs)
    mean = math.fsum(xs) / n
    sd = math.sqrt(math.fsum((x - mean) ** 2 for x in xs) / (n - 1)) if n > 1 else 0.0
    return mean, sd


# --- segments and the ideal lap -------------------------------------------------------------


@dataclass(frozen=True)
class Segment:
    label: str
    corner_id: str | None
    start_m: float
    end_m: float


def map_segments(tmap: TrackMap) -> list[Segment]:
    """Boundaries at 0, every corner start and end, and the track length, so the segments tile
    the lap. A segment that is a corner's own run is that corner (a corner over the start line
    gives two pieces, both named for it); the others are straights named from the corner before
    and the one after."""
    corners = sorted(tmap.corners, key=lambda c: c.start_m)
    length = tmap.length_m
    bounds = sorted(
        {0.0, length}
        | {m for c in corners for m in (c.start_m, c.end_m) if 0 < m < length}
    )
    out: list[Segment] = []
    for a, b in zip(bounds, bounds[1:], strict=False):
        mid = (a + b) / 2
        inside = next((c for c in corners if _in_corner(c, mid)), None)
        if inside is not None:
            out.append(Segment(inside.name, inside.id, a, b))
            continue
        before = next((c for c in reversed(corners) if c.end_m <= a), None)
        after = next((c for c in corners if c.start_m >= b), None)
        label = f"{before.name if before else 'Start'} → {after.name if after else 'Finish'}"
        out.append(Segment(label, None, a, b))
    return out


def _in_corner(c: Corner, m: float) -> bool:
    if c.start_m <= c.end_m:
        return c.start_m <= m < c.end_m
    return m >= c.start_m or m < c.end_m


def segment_durations(trace: LapTrace, segs: list[Segment], lap_time_s: float) -> list[float]:
    """Seconds spent in each segment on the lap's own clock, scaled so they add up to the
    official lap time (the grid's last sample differs a little from it)."""
    t = np.asarray(trace.ch["t"], dtype=float)
    last = len(t) - 1

    def at(m: float) -> float:
        return float(t[min(round(m), last)])

    total = at(last) - at(0)
    scale = lap_time_s / total if lap_time_s > 0 and total > 0 else 1.0
    return [(at(s.end_m) - at(s.start_m)) * scale for s in segs]


@dataclass(frozen=True)
class IdealSegment:
    label: str
    corner_id: str | None
    start_m: float
    end_m: float
    best_s: float
    lap_id: str
    lap_no: int
    session_id: str


@dataclass(frozen=True)
class IdealLap:
    time_s: float
    scope: IdealScope
    segments: list[IdealSegment]


def ideal_lap(laps: list[LapPair], tmap: TrackMap, scope: IdealScope = "session") -> IdealLap:
    """The best time of each map segment over the valid flying laps given, and the lap it came
    from (the first of them on a tie, so pass laps oldest first). `time_s` is the sum of the
    segments' `best_s`. The caller picks the laps for the scope. Raises NoValidLaps."""
    pool = timed_laps(laps)
    if not pool:
        raise NoValidLaps("There is no valid timed lap to build an ideal lap from.")
    segs = map_segments(tmap)
    durs = [segment_durations(tr, segs, m.lap_time_s or 0.0) for m, tr in pool]
    segments: list[IdealSegment] = []
    for k, s in enumerate(segs):
        best = 0
        for i in range(1, len(pool)):
            if durs[i][k] < durs[best][k]:
                best = i
        m = pool[best][0]
        segments.append(
            IdealSegment(
                s.label, s.corner_id, s.start_m, s.end_m,
                round(durs[best][k], 3), m.lap_id, m.lap_no, m.session_id,
            )
        )  # fmt: skip
    return IdealLap(round(sum(s.best_s for s in segments), 3), scope, segments)


# --- consistency ----------------------------------------------------------------------------


@dataclass(frozen=True)
class CornerSpread:
    corner_id: str
    name: str
    mean_s: float
    sd_s: float
    min_s: float
    max_s: float


@dataclass(frozen=True)
class SessionConsistency:
    n_laps: int
    mean_s: float
    sd_s: float
    best_s: float
    theoretical_best_sectors_s: float | None  # None when a lap has no sector times
    theoretical_best_s: float  # the ideal lap's time (segments)
    corners: list[CornerSpread]  # largest sd first


def corner_time(trace: LapTrace, corner: Corner) -> float:
    """Seconds from the corner's start to its end (across the start line when it wraps)."""
    t = np.asarray(trace.ch["t"], dtype=float)
    return float(walk_cumulative(t, corner_walk(corner, len(t)))[-1])


def corner_spreads(traces: list[LapTrace], tmap: TrackMap) -> list[CornerSpread]:
    out: list[CornerSpread] = []
    for c in tmap.corners:
        times = [corner_time(tr, c) for tr in traces]
        mean, sd = _mean_sd(times)
        out.append(
            CornerSpread(c.id, c.name, round(mean, 3), round(sd, 3),
                         round(min(times), 3), round(max(times), 3))
        )  # fmt: skip
    out.sort(key=lambda s: s.sd_s, reverse=True)
    return out


def sector_theoretical_best(metas: list[LapMeta]) -> float | None:
    """Sum of the best time of each sector. None unless every lap has the same, non-zero
    number of sector times."""
    sectors = [m.sectors_s for m in metas]
    if not sectors or not sectors[0] or any(len(s) != len(sectors[0]) for s in sectors):
        return None
    return round(sum(min(s[k] for s in sectors) for k in range(len(sectors[0]))), 3)


def session_consistency(laps: list[LapPair], tmap: TrackMap) -> SessionConsistency:
    """Lap mean and sd, best, theoretical best (sectors and segments) and the spread of each
    corner's time, widest first. Raises NotEnoughLaps with fewer than 2 valid flying laps."""
    pool = timed_laps(laps)
    if len(pool) < MIN_LAPS:
        raise NotEnoughLaps("Checking consistency needs at least 2 valid timed laps.")
    times = [m.lap_time_s or 0.0 for m, _ in pool]
    mean, sd = _mean_sd(times)
    return SessionConsistency(
        n_laps=len(pool),
        mean_s=round(mean, 3),
        sd_s=round(sd, 3),
        best_s=round(min(times), 3),
        theoretical_best_sectors_s=sector_theoretical_best([m for m, _ in pool]),
        theoretical_best_s=ideal_lap(pool, tmap, "session").time_s,
        corners=corner_spreads([tr for _, tr in pool], tmap),
    )


# --- focus tracking -------------------------------------------------------------------------


@dataclass(frozen=True)
class FocusItem:
    """A corner the driver was told to work on. `baseline_s` is the corner's mean time in the
    session the advice was given (from `corner_spreads`)."""

    corner_id: str
    instruction: str
    baseline_s: float


def evaluate_focus(item: FocusItem, laps: list[LapPair], tmap: TrackMap) -> bool | None:
    """Did the corner get faster? Compares its mean time over the valid flying laps with the
    baseline: True at -0.05 s or better, False at +0.05 s or worse, else None. None too with
    fewer than 2 valid laps or when the corner is not on the map."""
    corner = next((c for c in tmap.corners if c.id == item.corner_id), None)
    pool = timed_laps(laps)
    if corner is None or len(pool) < MIN_LAPS:
        return None
    mean = _mean_sd([corner_time(tr, corner) for _, tr in pool])[0]
    change = round(mean - item.baseline_s, 6)
    if change <= -FOCUS_THRESHOLD_S:
        return True
    if change >= FOCUS_THRESHOLD_S:
        return False
    return None
