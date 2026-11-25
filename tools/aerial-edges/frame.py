"""LMU's world frame (x, z metres), the lap's centreline in it, and its alignment to the real world (OSM raceway)."""
from __future__ import annotations

import json
import math
import time
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np
from scipy.ndimage import gaussian_filter1d
from scipy.spatial import cKDTree

from sources.base import USER_AGENT

M_PER_DEG = 6371008.8 * math.pi / 180
COS_LAT = math.cos(math.radians(60))
OVERPASS = "https://overpass-api.de/api/interpreter"


def world(lat, lon) -> np.ndarray:
    """World x, z (n x 2) from a recording's GPS (docs/lmu-duckdb-schema.md)."""
    lat, lon = np.asarray(lat, float), np.asarray(lon, float)
    return np.stack([lon * M_PER_DEG * COS_LAT, (lat - 60) * M_PER_DEG], 1)


def normals_left(p: np.ndarray, half: int = 3) -> np.ndarray:
    t = np.roll(p, -half, 0) - np.roll(p, half, 0)
    t /= np.maximum(np.hypot(t[:, 0], t[:, 1]), 1e-9)[:, None]
    return np.stack([-t[:, 1], t[:, 0]], 1)


def smooth(p: np.ndarray, sigma: float) -> np.ndarray:
    return gaussian_filter1d(p, sigma, axis=0, mode="wrap")


def load_laps(paths: list[Path]) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Centreline (world x/z, about one point per metre) and LMU's left and right half-widths (NaN = no lap on that side),
    from every lap within 5 % of the fastest in the mock recordings (no pit laps): car position + Path Lateral (+ = right) and the recorded track edge."""
    laps = [l for p in paths for l in json.loads(p.read_text())["laps"] if l["lap_time_s"]]
    best = min(l["lap_time_s"] for l in laps)
    laps = [l for l in laps if l["lap_time_s"] < 1.05 * best]
    n = min(len(l["lat"]) for l in laps)
    lines, sides = [], ([], [])
    for l in laps:
        p = smooth(world(l["lat"][:n], l["lon"][:n]), 3)
        lat_m = np.asarray(l["path_lateral"][:n], float)
        lines.append(p + normals_left(p) * lat_m[:, None])
        edge = np.abs(np.asarray(l["track_edge"][:n], float))
        for s, on in ((0, lat_m < 0), (1, lat_m > 0)):
            sides[s].append(np.where(on & (edge > 2) & (edge < 15), edge, np.nan))
    c = smooth(np.median(lines, 0), 4)
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        left, right = (np.nanmedian(s, 0) for s in sides)
    return c, left, right


def fill(v: np.ndarray, sigma: float) -> np.ndarray:
    """Closed-loop interpolation over NaN, then smoothing."""
    n = len(v)
    ok = np.flatnonzero(np.isfinite(v))
    if not len(ok):
        return np.full(n, 6.0)
    return gaussian_filter1d(np.interp(np.arange(n), ok, v[ok], period=n), sigma, mode="wrap")


def osm_raceway(bbox: list[float], cache: Path) -> list[np.ndarray]:
    """OSM raceway ways (lat, lon) in (south, west, north, east), karting left out. © OpenStreetMap contributors, ODbL."""
    f = cache / f"osm_{'_'.join(str(b) for b in bbox)}.json"
    if not f.exists():
        q = f'[out:json][timeout:60];(way["highway"="raceway"]({",".join(map(str, bbox))}););out geom tags;'
        for k in range(6):
            try:
                r = urllib.request.Request(OVERPASS, urllib.parse.urlencode({"data": q}).encode(), {"User-Agent": USER_AGENT})
                data = urllib.request.urlopen(r, timeout=90).read()
                if b'"elements"' in data:
                    break
            except OSError:
                pass
            time.sleep(20 * 2**k)
        else:
            raise SystemExit("Overpass did not answer")
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(data)
    return [np.array([(g["lat"], g["lon"]) for g in e["geometry"]]) for e in json.loads(f.read_text())["elements"]
            if e["tags"].get("sport") != "karting"]


def similarity(a: np.ndarray, b: np.ndarray, w: np.ndarray | None = None) -> tuple[float, float, np.ndarray]:
    """Scale, rotation (radians) and translation that best map a onto b (no mirroring)."""
    w = np.ones(len(a)) if w is None else w
    ca, cb = np.average(a, axis=0, weights=w), np.average(b, axis=0, weights=w)
    za, zb = (a - ca) @ [1, 1j], (b - cb) @ [1, 1j]
    k = np.sum(w * np.conj(za) * zb) / np.sum(w * np.abs(za) ** 2)
    s, r = abs(k), float(np.angle(k))
    return s, r, cb - apply((s, r, np.zeros(2)), ca[None])[0]


def apply(t, p: np.ndarray) -> np.ndarray:
    s, r, d = t
    c, n = s * math.cos(r), s * math.sin(r)
    return p @ np.array([[c, n], [-n, c]]) + d


def coarse_fit(centre: np.ndarray, osm: np.ndarray):
    """Trimmed ICP of the centreline onto dense OSM points, from several start rotations. (transform, distances)."""
    tree, best = cKDTree(osm), None
    for deg in range(-20, 21, 5):
        t = (1.0, math.radians(deg), osm.mean(0) - apply((1.0, math.radians(deg), np.zeros(2)), centre.mean(0)[None])[0])
        for k in range(120):
            d, i = tree.query(apply(t, centre))
            keep = d <= max(np.percentile(d, 85), 3)
            t = similarity(centre[keep], osm[i[keep]])
        d, _ = tree.query(apply(t, centre))
        if best is None or np.median(d) < np.median(best[1]):
            best = (t, d)
    return best


def densify(way: np.ndarray, step: float = 1.0) -> np.ndarray:
    seg = np.hypot(*np.diff(way, axis=0).T)
    s = np.r_[0, np.cumsum(seg)]
    q = np.arange(0, s[-1], step)
    return np.stack([np.interp(q, s, way[:, k]) for k in (0, 1)], 1)
