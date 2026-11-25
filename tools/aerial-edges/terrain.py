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
