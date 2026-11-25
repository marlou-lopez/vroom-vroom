"""Deterministic per-corner facts the coach is given (the LLM only phrases these).

`corner_facts` compares one corner of a lap against the reference, `lap_facts` does every
corner of a lap and sorts them by time lost. The numbers are the ones the compare endpoint's
`corners` table shows, so the table and the coach text agree. Positions are never given to the
coach as metres: `cues` hold landmark phrases (`describe_position`), or None.
"""

from __future__ import annotations

from dataclasses import dataclass, replace

import numpy as np

from racecoach.analysis.balance import LapBalance
from racecoach.analysis.delta import (
    apex_position,
    corner_delta,
    corner_walk,
    delta_time,
    walk_cumulative,
)
from racecoach.analysis.landmarks import describe_position, usable_landmarks
from racecoach.analysis.metrics import BRAKE_ONSET, SideMetrics, corner_side
from racecoach.model import LapTrace
from racecoach.tracks import Corner, Landmark, TrackMap

FLAT_MAX_BRAKE = BRAKE_ONSET


@dataclass(frozen=True)
class PhaseLoss:
    """Seconds lost (lap minus reference, + = lost) in the three parts of a corner: entry runs
    from the corner start to the apex, mid from the apex to halfway to the corner end, exit
    the rest. The three add up to the corner's delta."""

    entry_s: float
    mid_s: float
    exit_s: float


@dataclass(frozen=True)
class Cues:
    brake_lap: str | None
    brake_ref: str | None
    throttle_lap: str | None
    throttle_ref: str | None


@dataclass(frozen=True)
class CornerFacts:
    corner_id: str
    name: str
    delta_s: float
    phases: PhaseLoss
    flat: bool
    lap: SideMetrics  # onset, release and trail rate are None for a flat corner
    ref: SideMetrics
    steer_extra: int  # extra steering corrections over the reference (never negative)
    cues: Cues


@dataclass(frozen=True)
class StraightDelta:
    start_m: int
    end_m: int
    delta_s: float


@dataclass(frozen=True)
class LapFacts:
    total_delta_s: float
    corners: list[CornerFacts]  # most time lost first
    straights: list[StraightDelta]


def phase_losses(delta: np.ndarray, corner: Corner) -> PhaseLoss:
    walk = corner_walk(corner, len(delta))
    cum = walk_cumulative(delta, walk)
    last = len(walk) - 1
    apex_k = int(np.argmin(np.abs(walk.u - apex_position(corner, len(delta)))))
    mid_k = (apex_k + last) // 2
    return PhaseLoss(
        entry_s=round(float(cum[apex_k]), 6),
        mid_s=round(float(cum[mid_k] - cum[apex_k]), 6),
        exit_s=round(float(cum[last] - cum[mid_k]), 6),
    )


def is_flat(lap: SideMetrics, ref: SideMetrics) -> bool:
    """A corner taken without braking on both laps."""
    return lap.peak_brake < FLAT_MAX_BRAKE and ref.peak_brake < FLAT_MAX_BRAKE


def _without_braking(s: SideMetrics) -> SideMetrics:
    return replace(s, brake_onset_m=None, release_point_m=None, trail_release_rate=None)


def _cue(pos: int | None, landmarks: list[Landmark], length_m: float | None) -> str | None:
    return None if pos is None else describe_position(pos, landmarks, length_m)


def corner_facts(
    corner: Corner,
    lap: LapTrace,
    ref: LapTrace,
    delta: np.ndarray,
    landmarks: list[Landmark] | None = None,
    lap_balance: LapBalance | None = None,
    ref_balance: LapBalance | None = None,
    length_m: float | None = None,
) -> CornerFacts:
    lap_side = corner_side(lap, corner, None if lap_balance is None else lap_balance.balance)
    ref_side = corner_side(ref, corner, None if ref_balance is None else ref_balance.balance)
    flat = is_flat(lap_side, ref_side)
    anchors = usable_landmarks([lm for lm in landmarks or [] if lm.corner_id == corner.id])
    apex_kerbs = [lm for lm in anchors if lm.kind == "kerb_apex"]
    cues = Cues(
        brake_lap=None if flat else _cue(lap_side.brake_onset_m, anchors, length_m),
        brake_ref=None if flat else _cue(ref_side.brake_onset_m, anchors, length_m),
        throttle_lap=_cue(lap_side.throttle_pickup_m, apex_kerbs, length_m),
        throttle_ref=_cue(ref_side.throttle_pickup_m, apex_kerbs, length_m),
    )
    if flat:
        lap_side, ref_side = _without_braking(lap_side), _without_braking(ref_side)
    return CornerFacts(
        corner_id=corner.id,
        name=corner.name,
        delta_s=round(corner_delta(delta, corner), 6),
        phases=phase_losses(delta, corner),
        flat=flat,
        lap=lap_side,
        ref=ref_side,
        steer_extra=max(0, lap_side.steer_corrections - ref_side.steer_corrections),
        cues=cues,
    )


def straight_deltas(delta: np.ndarray, corners: list[Corner]) -> list[StraightDelta]:
    """The stretches outside every corner, each with its time delta. Together with the corner
    deltas they add up to the lap's total delta (corners must not overlap)."""
    last = len(delta) - 1
    covered = np.zeros(len(delta), dtype=bool)
    owner = np.full(len(delta), -1)
    for k, c in enumerate(corners):
        idx = corner_walk(c, len(delta)).idx
        covered[idx] = True
        owner[idx] = k
    out: list[StraightDelta] = []
    i = 0
    while i <= last:
        if covered[i]:
            i += 1
            continue
        j = i
        while j + 1 <= last and not covered[j + 1]:
            j += 1
        # the stretch runs from the end of the previous corner (or the line) to the next one's start
        a = max(i - 1, 0)
        b = min(j + 1, last)
        out.append(StraightDelta(a, b, round(float(delta[b] - delta[a]), 6)))
        i = j + 1
    # a step between two corners with no metre between them belongs to neither corner
    for i in range(last):
        if covered[i] and covered[i + 1] and owner[i] != owner[i + 1]:
            out.append(StraightDelta(i, i + 1, round(float(delta[i + 1] - delta[i]), 6)))
    out.sort(key=lambda x: x.start_m)
    return out


def lap_facts(
    tmap: TrackMap,
    lap: LapTrace,
    ref: LapTrace,
    lap_balance: LapBalance | None = None,
    ref_balance: LapBalance | None = None,
) -> LapFacts:
    delta = delta_time(lap, ref)
    facts = [
        corner_facts(c, lap, ref, delta, tmap.landmarks, lap_balance, ref_balance, tmap.length_m)
        for c in tmap.corners
    ]
    facts.sort(key=lambda f: f.delta_s, reverse=True)
    return LapFacts(
        total_delta_s=round(float(delta[-1] - delta[0]), 6),
        corners=facts,
        straights=straight_deltas(delta, tmap.corners),
    )
