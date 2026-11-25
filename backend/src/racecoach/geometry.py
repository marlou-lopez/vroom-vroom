"""Track geometry for `GET /api/tracks/{id}/geometry`: centreline, elevation, survey, aerial edges.

Ports `frontend/src/lib/{elevation,trackSurvey,aerialEdges}.ts` (the mock's maths) so the real API
serves what the mock does. The derived data (a shared-memory elevation capture, a survey, aerial
edges) are JSON files written by `tools/lmu-logger` and `tools/aerial-edges`, kept per track in
`track_data_dir/<track_id>/{elevation,survey,aerial}.json`; a track without one gets `null` for
that part.
"""

from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import numpy as np
from scipy.spatial import KDTree

# The recording's GPS is a fixed transform of the game's world x/z
# (docs/lmu-duckdb-schema.md, "Shared memory").
EARTH_RADIUS_M = 6371008.8
M_PER_DEG = EARTH_RADIUS_M * math.pi / 180
LAT_ORIGIN = 60.0
COS_LAT_ORIGIN = math.cos(math.radians(LAT_ORIGIN))

MAX_MATCH_M = 5.0  # elevation: beyond this the nearest captured path is not the same road
MAX_SEGMENT_M = 5.0  # capture segments longer than this are jumps (a teleport), not road
SURVEY_MATCH_M = 15.0  # survey samples further than this from the centreline are not on that road
SURVEY_GAP_M = 8  # gaps up to this between measured indices are interpolated and count as measured
KERB_MERGE_M = 5  # kerb runs on one side separated by at most this are one run
KERB_MIN_M = 3  # shorter kerb runs are dropped as noise


def latlon_to_world(lat: np.ndarray, lon: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    return lon * M_PER_DEG * COS_LAT_ORIGIN, (lat - LAT_ORIGIN) * M_PER_DEG


def world_to_latlon(x: float, z: float) -> tuple[float, float]:
    return LAT_ORIGIN + z / M_PER_DEG, x / (M_PER_DEG * COS_LAT_ORIGIN)


def _nearest_on_segments(
    q: np.ndarray, a: np.ndarray, b: np.ndarray
) -> tuple[np.ndarray, np.ndarray]:
    """Per segment a->b: the clamped position u of point `q` along it, and the distance."""
    v = b - a
    len2 = (v**2).sum(axis=1)
    safe = np.where(len2 > 0, len2, 1.0)
    u = np.where(len2 > 0, np.clip(((q - a) * v).sum(axis=1) / safe, 0.0, 1.0), 0.0)
    d = np.hypot(*(q - (a + u[:, None] * v)).T)
    return u, d


class PolylineMatcher:
    """Maps world x/z to the nearest grid index of the centreline polyline (None beyond `max_m`)."""

    def __init__(self, lat: np.ndarray, lon: np.ndarray, max_m: float = SURVEY_MATCH_M) -> None:
        x, z = latlon_to_world(np.asarray(lat, float), np.asarray(lon, float))
        self.pts = np.column_stack([x, z])
        self.n = len(self.pts)
        self.max_m = max_m
        self.tree = KDTree(self.pts) if self.n else None

    def match(self, x: float, z: float) -> int | None:
        if self.tree is None:
            return None
        q = np.array([x, z])
        best, best_idx = math.inf, -1
        # 1 m segments: every segment within max_m has an endpoint within max_m + 1 of the point
        for j in self.tree.query_ball_point(q, self.max_m + 1.0):
            for i in (j - 1, j):
                if i < 0 or i + 1 >= self.n:
                    continue
                u, d = _nearest_on_segments(q, self.pts[i : i + 1], self.pts[i + 1 : i + 2])
                if d[0] < best:
                    best, best_idx = float(d[0]), i + 1 if u[0] >= 0.5 else i
        return best_idx if best <= self.max_m else None


@dataclass
class ElevationIndex:
    a: np.ndarray  # (k, 3) segment starts: x, z, y
    b: np.ndarray  # (k, 3) segment ends
    tree: KDTree | None


def build_elevation_index(capture: dict[str, Any]) -> ElevationIndex:
    pts = np.asarray(capture["points"], float).reshape(-1, 3)
    starts: list[int] = []
    for lap in capture["laps"]:
        for i in range(lap["start_index"], lap["end_index"] - 1):
            if math.hypot(pts[i + 1, 0] - pts[i, 0], pts[i + 1, 1] - pts[i, 1]) <= MAX_SEGMENT_M:
                starts.append(i)
    idx = np.asarray(starts, int)
    a, b = pts[idx], pts[idx + 1]
    tree = KDTree((a[:, :2] + b[:, :2]) / 2) if len(idx) else None
    return ElevationIndex(a, b, tree)


def elevation_profile(
    idx: ElevationIndex, lat: np.ndarray, lon: np.ndarray, max_m: float = MAX_MATCH_M
) -> list[float | None]:
    """Height (m) at each grid point, null where the capture has no path within `max_m`."""
    x, z = latlon_to_world(np.asarray(lat, float), np.asarray(lon, float))
    out: list[float | None] = []
    for qx, qz in zip(x, z, strict=True):
        best_y: float | None = None
        if idx.tree is not None:
            cand = idx.tree.query_ball_point([qx, qz], max_m + MAX_SEGMENT_M / 2)
            if cand:
                a, b = idx.a[cand], idx.b[cand]
                u, d = _nearest_on_segments(np.array([qx, qz]), a[:, :2], b[:, :2])
                k = int(np.argmin(d))
                if d[k] <= max_m:
                    best_y = float(a[k, 2] + u[k] * (b[k, 2] - a[k, 2]))
        out.append(None if best_y is None else round(best_y, 2))
    return out


def _fill(groups: list[list[float]]) -> list[float | None]:
    """Median per index, gaps of at most SURVEY_GAP_M between measured indices interpolated."""
    v: list[float | None] = [float(np.median(s)) if s else None for s in groups]
    prev = -1
    for i, cur in enumerate(v):
        if cur is None:
            continue
        p = v[prev] if prev >= 0 else None
        if p is not None and 1 < i - prev <= SURVEY_GAP_M:
            for k in range(prev + 1, i):
                v[k] = p + (cur - p) * (k - prev) / (i - prev)
        prev = i
    return [None if x is None else round(x, 2) for x in v]


def _common_kind(counts: dict[str, int]) -> str:
    best = "flat"
    for k in ("razor", "other"):
        if counts[k] > counts[best]:
            best = k
    return best


def map_survey(survey: dict[str, Any], m: PolylineMatcher) -> dict[str, Any]:
    n = m.n
    samples: list[list[list[float]]] = [[[] for _ in range(n)], [[] for _ in range(n)]]
    for x, z, side, half in survey["edges"]:
        i = m.match(x, z)
        if i is not None and i < n:
            samples[int(side)][i].append(half)
    bank: list[list[float]] = [[] for _ in range(n)]
    for x, z, deg in survey.get("bank") or []:
        i = m.match(x, z)
        if i is not None and i < n:
            bank[i].append(deg)

    hits: list[dict[int, dict[str, int]]] = [{}, {}]
    for x, z, side, kind in survey["kerbs"]:
        i = m.match(x, z)
        if i is None or i >= n:
            continue
        c = hits[int(side)].setdefault(i, {"flat": 0, "razor": 0, "other": 0})
        c[kind] += 1
    kerbs: list[dict[str, Any]] = []
    for side in (0, 1):
        runs: list[list[int]] = []
        for i in sorted(hits[side]):
            if runs and i - runs[-1][-1] - 1 <= KERB_MERGE_M:
                runs[-1].append(i)
            else:
                runs.append([i])
        for run in runs:
            if run[-1] - run[0] + 1 < KERB_MIN_M:
                continue
            total = {"flat": 0, "razor": 0, "other": 0}
            for i in run:
                total[_common_kind(hits[side][i])] += 1
            kerbs.append({
                "side": "left" if side == 0 else "right", "start_m": run[0], "end_m": run[-1],
                "kind": _common_kind(total), "width_m": None,
            })  # fmt: skip
    kerbs.sort(key=lambda k: (k["start_m"], k["side"]))

    edge_points: list[list[float]] = []
    kerb_outer: list[list[float]] = []
    for x, z, kind in survey.get("contacts") or []:
        if m.match(x, z) is None:
            continue
        la, lo = world_to_latlon(x, z)
        (edge_points if kind == "edge" else kerb_outer).append([round(la, 7), round(lo, 7)])
    return {
        "left_m": _fill(samples[0]), "right_m": _fill(samples[1]), "bank_deg": _fill(bank),
        "kerbs": kerbs, "edge_points": edge_points, "kerb_outer_points": kerb_outer,
    }  # fmt: skip


def map_aerial(aerial: dict[str, Any], m: PolylineMatcher) -> dict[str, Any]:
    edge_points: list[list[float]] = []
    for x, z, *_ in aerial["edges"]:
        if m.match(x, z) is None:
            continue
        la, lo = world_to_latlon(x, z)
        edge_points.append([round(la, 7), round(lo, 7)])
    kerbs: list[dict[str, Any]] = []
    for k in aerial["kerbs"]:
        a, b = m.match(*k["start"]), m.match(*k["end"])
        if a is not None and b is not None and a < b:
            kerbs.append({
                "side": k["side"], "start_m": a, "end_m": b, "kind": "flat",
                "width_m": k["width_m"],
            })  # fmt: skip
    return {
        "edge_points": edge_points, "kerbs": kerbs, "attribution": aerial["attribution"],
        "licence_url": aerial.get("licence_url") or None,
    }  # fmt: skip


def _load(path: Path) -> dict[str, Any] | None:
    if not path.is_file():
        return None
    with path.open() as f:
        return json.load(f)


def track_data_files(data_dir: Path, track_id: str) -> dict[str, Path]:
    return {k: data_dir / track_id / f"{k}.json" for k in ("elevation", "survey", "aerial")}


def build_geometry(
    track_id: str,
    length_m: float,
    lat: np.ndarray,
    lon: np.ndarray,
    data_dir: Path,
    telemetry: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """The `TrackGeometry` JSON for a centreline (a flying lap) and the track's data files.

    `telemetry` is the fallback from `racecoach.edges.telemetry_edges`; it is served only when the
    track has no survey (a survey always wins).
    """
    files = track_data_files(data_dir, track_id)
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    elev, survey, aerial = (_load(files[k]) for k in ("elevation", "survey", "aerial"))
    matcher = PolylineMatcher(lat, lon)
    surveyed = map_survey(survey, matcher) if survey else None
    coverage = None
    if surveyed:

        def share(v: list[float | None]) -> float:
            return round(sum(x is not None for x in v) / len(v), 3) if v else 0.0

        coverage = {"left": share(surveyed["left_m"]), "right": share(surveyed["right_m"])}
    return {
        "track_id": track_id,
        "length_m": length_m,
        "centre": {"lat": lat.tolist(), "lon": lon.tolist()},
        "elevation_m": elevation_profile(build_elevation_index(elev), lat, lon) if elev else None,
        "survey": surveyed,
        "aerial": map_aerial(aerial, matcher) if aerial else None,
        "coverage": coverage,
        "telemetry": telemetry if surveyed is None else None,
        "transform": {
            "local": {
                "kind": "equirectangular", "earth_radius_m": EARTH_RADIUS_M,
                "origin_lat_deg": LAT_ORIGIN, "origin_lon_deg": 0.0,
            },
            "real_world": None,
        },
    }  # fmt: skip
