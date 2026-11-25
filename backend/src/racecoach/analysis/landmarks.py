"""Kerb landmarks and position cues: positions phrased against landmarks, never metres."""

from __future__ import annotations

import re

import numpy as np

from racecoach.model import LapTrace
from racecoach.tracks import Corner, Landmark, TrackMap

HIT_GAP_M = 10  # kerb hits closer than this on one lap form one run
CLUSTER_M = 10  # kerb runs from different laps closer than this are one kerb
MIN_LAP_SHARE = 0.5  # a kerb must be hit on at least this share of the laps
APEX_ZONE_M = 15  # within this of the apex counts as the apex kerb
EDGE_MARGIN_M = 1.5  # a hit counts when the car is within this of the track edge
# Suspension velocity (m/s) that counts as a kerb strike. Unvalidated: the Susp Pos unit is
# unchecked (docs/lmu-duckdb-schema.md) and the fixture never reaches it, so the kerb flag carries
# detection on real data.
SUSP_PEAK_MS = 0.6

AT_M = 8  # "at the <label>" within this many metres
MAX_M = 40  # no cue beyond this
BRAKE_ON = 0.1
OWN_LAP_TOL_M = 3

_DIGIT_M = re.compile(r"\d\s*(m|metres?|meters?)\b", re.IGNORECASE)
_SUSP = ("susp_fl", "susp_fr", "susp_rl", "susp_rr")


def _runs(mask: np.ndarray, gap: int) -> list[tuple[int, int]]:
    """Inclusive index runs of True, runs separated by fewer than `gap` False merged."""
    idx = np.flatnonzero(mask)
    if len(idx) == 0:
        return []
    runs: list[tuple[int, int]] = []
    start = prev = int(idx[0])
    for i in idx[1:]:
        if i - prev > gap:
            runs.append((start, prev))
            start = int(i)
        prev = int(i)
    runs.append((start, prev))
    return runs


def _near_edge(lap: LapTrace) -> np.ndarray | None:
    """True where the car is near the track edge; None when the lap has no lateral position."""
    lat = lap.ch.get("path_lateral")
    edge = lap.ch.get("track_edge")
    if lat is None or edge is None or not np.any(lat):
        return None
    return np.abs(lat) >= np.abs(edge) - EDGE_MARGIN_M


def _lap_hits(lap: LapTrace) -> np.ndarray:
    """Per metre: a wheel on a kerb (type 5 or 6) or a suspension-velocity peak at the track edge.

    Type 5 is also drains and concrete, so with a lateral position a hit counts only near the
    edge; without one the recording's kerb flag is taken as it is and suspension is not used.
    """
    n = len(lap.distance)
    hit = np.asarray(lap.ch.get("kerb", np.zeros(n))) > 0.5
    near = _near_edge(lap)
    if near is None:
        return hit
    t = np.asarray(lap.ch.get("t", np.zeros(n)), dtype=float)
    dt = np.gradient(t) if n > 1 else np.ones(n)
    dt = np.where(dt > 1e-6, dt, np.inf)
    peak = np.zeros(n, dtype=bool)
    for name in _SUSP:
        if name in lap.ch:
            peak |= np.abs(np.gradient(np.asarray(lap.ch[name], dtype=float)) / dt) >= SUSP_PEAK_MS
    return (hit | peak) & near


def _corner_for(corners: list[Corner], pos: float) -> Corner | None:
    inside = [c for c in corners if c.start_m <= pos <= c.end_m]
    return min(inside, key=lambda c: abs(c.apex_m - pos)) if inside else None


def detect_kerbs(laps: list[LapTrace], tmap: TrackMap) -> list[Landmark]:
    """Kerbs hit on at least half of `laps`, as `detected` landmarks classified against the
    corner they sit in (entry, apex within 15 m of the apex, exit). Kerbs outside any corner are
    left out: their label would have nothing to hang on."""
    if not laps:
        return []
    centres: list[tuple[float, int]] = []  # (distance, lap index)
    for li, lap in enumerate(laps):
        for a, b in _runs(_lap_hits(lap), HIT_GAP_M):
            centres.append((float(lap.distance[(a + b) // 2]), li))
    centres.sort()

    clusters: list[list[tuple[float, int]]] = []
    for c in centres:
        if clusters and c[0] - clusters[-1][-1][0] <= CLUSTER_M:
            clusters[-1].append(c)
        else:
            clusters.append([c])

    need = MIN_LAP_SHARE * len(laps)
    out: list[Landmark] = []
    seen: dict[str, int] = {}
    for cl in clusters:
        if len({li for _, li in cl}) < need:
            continue
        pos = float(np.median([d for d, _ in cl]))
        corner = _corner_for(tmap.corners, pos)
        if corner is None:
            continue
        if abs(pos - corner.apex_m) <= APEX_ZONE_M:
            kind, word = "kerb_apex", "apex"
        elif pos < corner.apex_m:
            kind, word = "kerb_entry", "entry"
        else:
            kind, word = "kerb_exit", "exit"
        base = f"{corner.id}-{kind}"
        seen[base] = seen.get(base, 0) + 1
        k = seen[base]
        out.append(
            Landmark(
                id=base if k == 1 else f"{base}-{k}",
                label=f"{corner.name} {word} kerb" if k == 1 else f"{corner.name} {word} kerb {k}",
                kind=kind,  # type: ignore[arg-type]
                distance_m=round(pos, 1),
                corner_id=corner.id,
                confidence="detected",
            )
        )
    return out


def usable_landmarks(landmarks: list[Landmark]) -> list[Landmark]:
    """Only detected or confirmed landmarks may appear in coaching; a label that carries a
    distance in metres is not usable either."""
    return [
        lm
        for lm in landmarks
        if lm.confidence in ("detected", "confirmed") and not _DIGIT_M.search(lm.label)
    ]


def describe_position(
    pos_m: float, landmarks: list[Landmark], length_m: float | None = None
) -> str | None:
    """"at / just before / shortly after the <label>" for the nearest usable landmark within
    40 m, else None. `length_m` lets the lap wrap round the start line."""
    best: tuple[float, Landmark] | None = None
    for lm in usable_landmarks(landmarks):
        d = pos_m - lm.distance_m  # > 0: the position is past the landmark
        if length_m:
            d = (d + length_m / 2) % length_m - length_m / 2
        if abs(d) <= MAX_M and (best is None or abs(d) < abs(best[0])):
            best = (d, lm)
    if best is None:
        return None
    d, lm = best
    if abs(d) <= AT_M:
        return f"at the {lm.label}"
    return f"just before the {lm.label}" if d < 0 else f"shortly after the {lm.label}"


def brake_points(lap: LapTrace) -> list[float]:
    """Distances where the brake goes from off to on."""
    if "brake" not in lap.ch:
        return []
    on = np.asarray(lap.ch["brake"], dtype=float) >= BRAKE_ON
    rising = np.flatnonzero(on[1:] & ~on[:-1]) + 1  # a brake already on at the start is no point
    return [float(lap.distance[i]) for i in rising]


def own_lap_cue(pos_m: float, laps: list[tuple[int, LapTrace]]) -> str | None:
    """"where you braked on lap 7": the driver's own braking point (from `laps`, as (lap number,
    trace)) within 3 m of `pos_m`; the closest wins, else None."""
    best: tuple[float, int] | None = None
    for lap_no, lap in laps:
        for p in brake_points(lap):
            gap = abs(p - pos_m)
            if gap <= OWN_LAP_TOL_M and (best is None or gap < best[0]):
                best = (gap, lap_no)
    return None if best is None else f"where you braked on lap {best[1]}"
