"""Track edges and kerbs rebuilt from telemetry, for a track with no survey (vroom-ohw).

A port of `frontend/src/lib/trackEdges.ts` (spike #36, `docs/track-views/edges-kerbs.md`),
computed once per track from all its laps. `track_edge` is the distance to the edge on the side the
car is on, so one lap only measures the side it drives on. Stretches no lap measured stay `None`:
they are never interpolated.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import numpy as np

LATERAL_LIMIT_M = 15.0  # |path_lateral| beyond this is pit lane or run-off
FLIP_GUARD_M = 6  # a track_edge sample counts only if its sign is steady within this many metres
EDGE_SMOOTH_HALF_M = 3  # measured half-widths are averaged over ± this, measured neighbours only
KERB_MERGE_M = 5  # kerb hits on one side closer than this are one run
KERB_MIN_M = 3  # shorter kerb runs are noise
KERB_MIN_LAPS = 2  # a kerb needs hits from this many laps (fewer if the track has fewer laps)
KERB_SAMPLE_HZ = 5.0  # the surface flag is sampled at 5 Hz: ends are widened by one sample
KERB_WIDEN_MAX_M = 15.0

# One lap's grid channels: path_lateral, track_edge, kerb, speed_kmh.
LapChannels = dict[str, np.ndarray]


def _valid_mask(path_lateral: np.ndarray, track_edge: np.ndarray) -> np.ndarray:
    """On-track samples whose sign is steady over ±FLIP_GUARD_M (10 Hz edge sweeps through 0)."""
    finite = np.isfinite(path_lateral) & np.isfinite(track_edge)
    on_track = finite & (np.abs(np.where(finite, path_lateral, 0.0)) <= LATERAL_LIMIT_M)
    sgn = np.where(on_track, np.sign(np.where(finite, track_edge, 0.0)), 0).astype(int)
    m = len(sgn)
    ok = np.zeros(m, dtype=bool)
    for s in (-1, 1):
        same = (sgn == s).astype(int)
        csum = np.concatenate([[0], np.cumsum(same)])
        lo = np.maximum(np.arange(m) - FLIP_GUARD_M, 0)
        hi = np.minimum(np.arange(m) + FLIP_GUARD_M, m - 1) + 1
        ok |= (csum[hi] - csum[lo] == hi - lo) & (sgn == s)
    return ok


def _smooth_measured(v: np.ndarray, measured: np.ndarray) -> np.ndarray:
    """Average measured values over ±EDGE_SMOOTH_HALF_M on the closed loop, measured only."""
    n = len(v)
    w = np.where(measured, v, 0.0)
    c = measured.astype(float)
    sw, sc = np.zeros(n), np.zeros(n)
    for k in range(-EDGE_SMOOTH_HALF_M, EDGE_SMOOTH_HALF_M + 1):
        sw += np.roll(w, -k)
        sc += np.roll(c, -k)
    return np.where(measured, sw / np.maximum(sc, 1.0), v)


def edge_half_widths(
    laps: Sequence[LapChannels], n: int
) -> tuple[list[float | None], list[float | None]]:
    """Left and right half-widths (m, positive) per grid metre; None where no lap measured."""
    samples: dict[int, list[list[float]]] = {s: [[] for _ in range(n)] for s in (-1, 1)}
    for lap in laps:
        m = min(n, len(lap["path_lateral"]), len(lap["track_edge"]))
        pl, te = lap["path_lateral"][:m], lap["track_edge"][:m]
        ok = _valid_mask(pl, te)
        for i in np.flatnonzero(ok):
            samples[-1 if te[i] < 0 else 1][i].append(abs(float(te[i])))
    sides: list[list[float | None]] = []
    for s in (-1, 1):  # left (negative edge) first
        v = np.zeros(n)
        measured = np.zeros(n, dtype=bool)
        for i, vals in enumerate(samples[s]):
            if vals:
                v[i], measured[i] = float(np.median(vals)), True
        sm = _smooth_measured(v, measured)
        sides.append([
            round(float(x), 3) if ok else None for x, ok in zip(sm, measured, strict=True)
        ])
    return sides[0], sides[1]


def _lap_runs(lap: LapChannels, n: int, side: str) -> list[tuple[int, int]]:
    """Kerb hit runs on one side of one lap, widened by one 5 Hz sample (that lap's own speed)."""
    m = min(n, len(lap["path_lateral"]), len(lap["kerb"]))
    p, k = lap["path_lateral"][:m], lap["kerb"][:m]
    left = side == "left"
    hit = (k == 1) & (np.abs(p) <= LATERAL_LIMIT_M) & (p != 0) & ((p < 0) == left)
    speed = lap.get("speed_kmh")
    runs: list[list[int]] = []
    for i in np.flatnonzero(hit):
        if runs and i - runs[-1][1] - 1 <= KERB_MERGE_M:
            runs[-1][1] = int(i)
        else:
            runs.append([int(i), int(i)])
    out = []
    for a, b in runs:
        sp = float(np.nanmean(speed[a : b + 1])) / 3.6 if speed is not None else 0.0
        w = int(round(min(max(sp, 0.0) / KERB_SAMPLE_HZ, KERB_WIDEN_MAX_M)))
        out.append((max(a - w, 0), min(b + w, n - 1)))
    return out


def kerb_clusters(laps: Sequence[LapChannels], n: int) -> list[dict[str, Any]]:
    """Kerbs clustered across laps: each end is the median of the laps' ends (inclusive metres)."""
    out: list[dict[str, Any]] = []
    for side in ("left", "right"):
        runs = sorted(
            (a, b, li) for li, lap in enumerate(laps) for a, b in _lap_runs(lap, n, side)
        )
        clusters: list[list[tuple[int, int, int]]] = []
        reach = -(10**9)
        for r in runs:
            if clusters and r[0] - reach - 1 <= KERB_MERGE_M:
                clusters[-1].append(r)
                reach = max(reach, r[1])
            else:
                clusters.append([r])
                reach = r[1]
        for c in clusters:
            start = int(round(float(np.median([r[0] for r in c]))))
            end = int(round(float(np.median([r[1] for r in c]))))
            support = len({r[2] for r in c})
            if end - start + 1 >= KERB_MIN_M and support >= min(KERB_MIN_LAPS, len(laps)):
                out.append({
                    "side": side, "start_m": start, "end_m": end, "kind": "other", "width_m": None,
                })  # fmt: skip
    return sorted(out, key=lambda k: (k["start_m"], k["side"]))


def telemetry_edges(laps: Sequence[LapChannels], n: int) -> dict[str, Any]:
    """The `TrackGeometry.telemetry` block: edges, kerbs and per-side measured share."""
    left, right = edge_half_widths(laps, n)

    def share(v: list[float | None]) -> float:
        return round(sum(x is not None for x in v) / len(v), 3) if v else 0.0

    return {
        "left_m": left, "right_m": right, "kerbs": kerb_clusters(laps, n),
        "coverage": {"left": share(left), "right": share(right)}, "laps": len(laps),
    }  # fmt: skip
