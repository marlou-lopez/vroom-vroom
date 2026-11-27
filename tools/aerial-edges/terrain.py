"""Is an open terrain model worth using for the ground beside the track? (vroom-ueg.9; `run.py ground spa --terrain 200`)

Reads Wallonia's 50 cm LiDAR terrain model (SPW, MNT 2021-2022) at points on and beside the centreline, one request each, and compares it
with LMU's recorded heights (on the line) and with the 3D view's assumption beside it (level with the track).
"""
from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import urlencode

import numpy as np
from pyproj import Transformer
from scipy.spatial import cKDTree

import build
import frame as fr
from sources.base import http_get

URL = "https://geoservices.wallonie.be/arcgis/rest/services/RELIEF/WALLONIE_MNT_2021_2022/MapServer/identify"
OFFSETS = (0, 10, -10, 30, -30, 75, -75, 150, -150)


def height(x: float, y: float) -> float | None:
    q = {"geometry": f"{x:.2f},{y:.2f}", "geometryType": "esriGeometryPoint", "sr": 3812, "layers": "all", "tolerance": 1, "returnGeometry": "false",
         "mapExtent": f"{x - 100},{y - 100},{x + 100},{y + 100}", "imageDisplay": "400,400,96", "f": "json"}
    for r in json.loads(http_get(f"{URL}?{urlencode(q)}")).get("results", []):
        try:
            return float(r["attributes"]["Stretch.Pixel Value"])
        except (KeyError, ValueError):
            return None
    return None


def check(cfg: dict, local: str, t, centre: np.ndarray, step: int, cache: Path) -> None:
    elev = json.loads((build.REPO / cfg["elevation"]).read_text())
    pts = np.array([p[:3] for p in elev["points"]], float)  # x, z, y
    tree = cKDTree(pts[:, :2])
    to_dtm = Transformer.from_crs(local, "EPSG:3812", always_xy=True)
    nn = fr.normals_left(centre, 4)
    f = cache / "terrain_wallonia.json"
    known = json.loads(f.read_text()) if f.exists() else {}
    rows: list = []
    for m in range(0, len(centre), step):
        row = [float(pts[tree.query(centre[m])[1], 2])]
        for off in OFFSETS:
            x, y = to_dtm.transform(*fr.apply(t, (centre[m] + off * nn[m])[None])[0])
            key = f"{x:.2f},{y:.2f}"  # the place asked for, so another fit or track never reads old answers
            if key not in known:
                got = height(x, y)
                if got is not None:  # a failed lookup is tried again next time
                    known[key] = got
                    f.write_text(json.dumps(known))
            row.append(known.get(key, np.nan))
        rows.append(row)
    v = np.array(rows)
    d = v[:, 1] - v[:, 0]
    off = np.nanmedian(d)
    print(f"on the line, {np.isfinite(d).sum()} points: offset {off:.2f} m, residual median abs {np.nanmedian(np.abs(d - off)):.2f}, p90 {np.nanpercentile(np.abs(d - off), 90):.2f}, max {np.nanmax(np.abs(d - off)):.2f} m")
    best = np.polyfit(v[np.isfinite(d), 0], v[np.isfinite(d), 1], 1)
    print(f"terrain = {best[0]:.4f} * LMU + {best[1]:.1f}")
    for dist in (10, 30, 75, 150):
        side = np.concatenate([v[:, 1 + OFFSETS.index(s)] - v[:, 1] for s in (dist, -dist)])
        a = np.abs(side[np.isfinite(side)])
        print(f"{dist:4d} m beside: height minus the track's, median abs {np.median(a):.2f}, p90 {np.percentile(a, 90):.2f}, max {a.max():.1f} m")


# --- node heights for the 3D view's ground (vroom-ueg.13) -------------------------------------------------------------------------------
# A low-poly terrain: the model is asked on a coarse lattice along the line, then interpolated to the 3D view's 4 m grid here, so the browser only
# reads the result. A public server answers one point at a time (1.5 s), so the lattice is thin, throttled and cached.
STATION_M = 30  # along the line
LATTICE = (10, 30, 75, 150)  # metres beside the line, both sides
GRID_M = 4  # the 3D view's mesh (ground.ts GRID_M)
WORKERS = 2
LICENCE = "CC BY 4.0"
LICENCE_URL = "https://creativecommons.org/licenses/by/4.0/"
CREDIT = "Terrain: Service public de Wallonie (SPW), Relief de la Wallonie - MNT 2021-2022 (CC BY 4.0), interpolated"
SOURCE_URL = "https://geodata.wallonie.be/id/a004e570-99d6-4fe5-b83d-49b774409278"


def _ask(points: list[tuple[float, float]], cache: Path) -> dict[str, float]:
    """MNT heights (m) at EPSG:3812 points; the cache file is shared with `check`. Failed lookups stay missing and are tried again next run."""
    from concurrent.futures import ThreadPoolExecutor
    import threading

    f = cache / "terrain_wallonia.json"
    known = json.loads(f.read_text()) if f.exists() else {}
    lock = threading.Lock()
    todo = [p for p in points if f"{p[0]:.2f},{p[1]:.2f}" not in known]
    done = 0

    def one(p):
        nonlocal done
        got = height(*p)
        with lock:
            if got is not None:
                known[f"{p[0]:.2f},{p[1]:.2f}"] = got
            done += 1
            if done % 100 == 0:
                f.write_text(json.dumps(known))
                print(f"terrain {done}/{len(todo)}", flush=True)

    with ThreadPoolExecutor(WORKERS) as ex:
        list(ex.map(one, todo))
    f.write_text(json.dumps(known))
    return known


def _lattice(centre: np.ndarray, stations: np.ndarray, offsets) -> tuple[np.ndarray, np.ndarray]:
    nn = fr.normals_left(centre, 4)
    pts = np.concatenate([centre[stations] + o * nn[stations] for o in offsets])
    return pts, np.repeat(np.array(offsets, float), len(stations))


def _heights_at(pts: np.ndarray, t, to_dtm, known_for) -> np.ndarray:
    xy = fr.apply(t, pts)
    x, y = to_dtm.transform(xy[:, 0], xy[:, 1])
    return np.array([known_for(f"{a:.2f},{b:.2f}") for a, b in zip(x, y)])


def build_heights(cfg: dict, local: str, t, centre: np.ndarray, tiles: list[dict], tile_m: int, out: Path, cache: Path) -> dict:
    """Writes `out/terrain.bin` (float32, row-major, north rows last, NaN nowhere) and returns the manifest entry. Heights are in LMU's frame:
    the model's minus one constant, the median offset between the model and LMU's recorded heights on the line."""
    from scipy.interpolate import LinearNDInterpolator, NearestNDInterpolator

    elev = json.loads((build.REPO / cfg["elevation"]).read_text())
    ep = np.array([p[:3] for p in elev["points"]], float)  # x, z, y
    tree = cKDTree(ep[:, :2])
    to_dtm = Transformer.from_crs(local, "EPSG:3812", always_xy=True)
    stations = np.arange(0, len(centre), STATION_M)
    offsets = [0, *LATTICE, *(-o for o in LATTICE)]
    pts, offs = _lattice(centre, stations, offsets)
    xy = fr.apply(t, pts)
    x3, y3 = to_dtm.transform(xy[:, 0], xy[:, 1])
    known = _ask(list(zip(x3, y3)), cache)
    z = np.array([known.get(f"{a:.2f},{b:.2f}", np.nan) for a, b in zip(x3, y3)])
    on = offs == 0
    lmu = ep[tree.query(pts[on])[1], 2]
    offset = float(np.nanmedian(z[on] - lmu))
    ok = np.isfinite(z)
    print(f"model minus LMU on the line: {offset:.2f} m; {int(ok.sum())}/{len(z)} lattice points answered")
    # Dense on-line heights from LMU (no query needed) pin the road, the lattice gives the sides.
    line = np.concatenate([pts[on][np.isfinite(z[on])], centre[::4]])
    line_h = np.concatenate([z[on][np.isfinite(z[on])] - offset, ep[tree.query(centre[::4])[1], 2]])
    P = np.concatenate([pts[ok & ~on], line])
    H = np.concatenate([z[ok & ~on] - offset, line_h])
    i0 = min(int(v["x"] // GRID_M) for v in tiles); k0 = min(int(v["z"] // GRID_M) for v in tiles)
    i1 = max(int((v["x"] + tile_m) // GRID_M) for v in tiles); k1 = max(int((v["z"] + tile_m) // GRID_M) for v in tiles)
    gi, gk = np.meshgrid(np.arange(i0, i1 + 1), np.arange(k0, k1 + 1))
    G = np.stack([gi.ravel() * GRID_M, gk.ravel() * GRID_M], 1).astype(float)
    lin, near = LinearNDInterpolator(P, H), NearestNDInterpolator(P, H)
    g = lin(G)
    bad = ~np.isfinite(g)
    g[bad] = near(G[bad])
    w, rows = i1 - i0 + 1, k1 - k0 + 1
    (out / "terrain.bin").write_bytes(g.astype("<f4").tobytes())
    return {"file": "terrain.bin", "i0": i0, "k0": k0, "w": w, "rows": rows, "grid_m": GRID_M, "offset_m": offset, "station_m": STATION_M, "lattice_m": list(LATTICE),
            "attribution": CREDIT, "licence": LICENCE, "licence_url": LICENCE_URL, "source_url": SOURCE_URL}


def verify(cfg: dict, local: str, t, centre: np.ndarray, out: Path, cache: Path) -> None:
    """Fresh model heights at stations between the lattice's, 10, 30 and 75 m beside the line, against the written grid (before any carve)."""
    man = json.loads((out / "ground.json").read_text())["terrain"]
    grid = np.fromfile(out / "terrain.bin", "<f4").reshape(man["rows"], man["w"])
    to_dtm = Transformer.from_crs(local, "EPSG:3812", always_xy=True)
    stations = np.arange(STATION_M // 2, len(centre), 3 * STATION_M)  # between the lattice's stations
    for dist in (10, 30, 75):
        pts, _ = _lattice(centre, stations, (dist, -dist))
        xy = fr.apply(t, pts)
        x3, y3 = to_dtm.transform(xy[:, 0], xy[:, 1])
        known = _ask(list(zip(x3, y3)), cache)
        m = np.array([known.get(f"{a:.2f},{b:.2f}", np.nan) for a, b in zip(x3, y3)]) - man["offset_m"]
        fi, fk = pts[:, 0] / man["grid_m"] - man["i0"], pts[:, 1] / man["grid_m"] - man["k0"]
        i, k = np.floor(fi).astype(int), np.floor(fk).astype(int)
        u, v = fi - i, fk - k
        sw, se, nw, ne = grid[k, i], grid[k, i + 1], grid[k + 1, i], grid[k + 1, i + 1]
        mesh = np.where(u >= v, sw + (se - sw) * u + (ne - se) * v, sw + (nw - sw) * v + (ne - nw) * u)
        e = np.abs(mesh - m)
        e = e[np.isfinite(e)]
        print(f"{dist:3d} m beside, {len(e)} points: |mesh - model| median {np.median(e):.2f} m, p90 {np.percentile(e, 90):.2f} m, max {e.max():.1f} m")
