"""Ground texture beside a track from open aerial imagery (vroom-ueg.9, experimental): see README.md.

    uv run --no-project --with numpy,scipy,pyproj,pillow python -I run.py ground spa

Square tiles in LMU's world frame (x east, z north, metres), so the 3D view places them without any other transform: 25 cm per
pixel where the track passes, 1 m further out. JPEG tiles and a ground.json with each tile's position and the credit line.
The output is imagery: it goes into a git-ignored folder and is never committed.
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
from pathlib import Path

import numpy as np
from PIL import Image
from pyproj import Transformer

import build
import frame as fr
import sources

TILE_M = 128
FINE_M, COARSE_M = 0.25, 1.0
OURS = re.compile(r"ground\.json|-?\d+_-?\d+\.jpg")
NEAR_M = 20  # a tile this close to the centreline is fine


def align(cfg: dict, cache: Path):
    """The fitted frame of build.py: (world to the source's projection, centreline in world metres, fit)."""
    src = sources.load(cfg["source"])
    s, w, n, e = cfg["bbox"]
    local = f"+proj=tmerc +lat_0={(s + n) / 2} +lon_0={(w + e) / 2} +datum=WGS84 +units=m +type=crs"
    to_local = Transformer.from_crs("EPSG:4326", local, always_xy=True)
    to_src = Transformer.from_crs(local, src.crs, always_xy=True)
    centre, left, right = fr.load_laps([build.REPO / r for r in cfg["recordings"]])
    raw = [left, right]
    osm = np.concatenate([fr.densify(np.stack(to_local.transform(v[:, 1], v[:, 0]), 1)) for v in fr.osm_raceway(cfg["bbox"], cache)])
    t, _, fit = build.refine(fr.coarse_fit(centre, osm)[0], centre, raw, [fr.fill(v, 4) for v in raw], build.Strip(src, to_src, cache))
    return src, local, t, centre, fit


def pick_tiles(centre: np.ndarray, reach: float) -> list[tuple[int, int, float]]:
    """(column, row, metres per pixel) of every tile whose box comes within `reach` of the centreline. Column = floor(x / 128), row = floor(z / 128)."""
    lo, hi = np.floor((centre.min(0) - reach) / TILE_M).astype(int), np.floor((centre.max(0) + reach) / TILE_M).astype(int)
    out = []
    for i in range(lo[0], hi[0] + 1):
        for k in range(lo[1], hi[1] + 1):
            box0 = np.array([i, k]) * TILE_M
            gap = np.maximum(np.maximum(box0 - centre, centre - box0 - TILE_M), 0)
            d = float(np.hypot(*gap.T).min())
            if d <= reach:
                out.append((i, k, FINE_M if d <= NEAR_M else COARSE_M))
    return out


def main(argv: list[str]) -> None:
    ap = argparse.ArgumentParser(prog="run.py ground", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("track", help="a file name in tracks/ without .json")
    ap.add_argument("--reach", type=float, default=150, help="metres either side of the centreline")
    ap.add_argument("--cache", type=Path, default=build.HERE / "cache")
    ap.add_argument("--out", type=Path, help="default: frontend/public/local-ground/<track_id of the app> (git-ignored)")
    ap.add_argument("--terrain", type=int, metavar="STEP", help="only compare a terrain model with LMU's heights, every STEP metres of the lap")
    a = ap.parse_args(argv)
    cfg = json.loads((build.HERE / "tracks" / f"{a.track}.json").read_text())
    src, local, t, centre, fit = align(cfg, a.cache)
    if a.terrain:
        import terrain
        return terrain.check(cfg, local, t, centre, a.terrain, a.cache)
    out = a.out or build.REPO / "frontend/public/local-ground" / cfg["track_id"]
    work = out.with_name(out.name + ".part")  # swapped in at the end, so an interrupted run leaves the old output alone
    for d in (out, work):
        if d.exists() and any(not OURS.fullmatch(f.name) for f in d.iterdir()):
            raise SystemExit(f"{d} holds other files than this tool writes: not replacing it")
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True)
    to_src = Transformer.from_crs(local, src.crs, always_xy=True)
    tiles, size = [], 0
    picked = pick_tiles(centre, a.reach)
    n = round(TILE_M / FINE_M)
    q = (np.arange(n) + 0.5) * FINE_M
    for done, (i, k, res) in enumerate(picked):
        x, z = np.meshgrid(i * TILE_M + q, (k + 1) * TILE_M - q)  # row 0 is the north side
        loc = fr.apply(t, np.stack([x.ravel(), z.ravel()], 1))
        sx, sy = to_src.transform(loc[:, 0], loc[:, 1])
        im, _ = src.sample(sx.reshape(n, n), sy.reshape(n, n), a.cache)
        f = round(res / FINE_M)
        im = im.reshape(n // f, f, n // f, f, 3).mean((1, 3))
        name = f"{i}_{k}.jpg"
        Image.fromarray(im.round().clip(0, 255).astype(np.uint8)).save(work / name, quality=82)
        size += (work / name).stat().st_size
        tiles.append({"file": name, "x": i * TILE_M, "z": k * TILE_M, "px": n // f})
        if done % 20 == 0:
            print(f"{done + 1}/{len(picked)}", flush=True)
    (work / "ground.json").write_text(json.dumps({
        "version": 1, "track": cfg["track"], "attribution": src.imagery_attribution + " (modified: resampled)",
        "licence": src.licence, "licence_url": src.licence_url, "source_url": src.source_url,
        "tile_m": TILE_M, "reach_m": a.reach, "fit": {"scale": t[0], "rotation_rad": t[1], **fit}, "tiles": tiles}))
    if out.exists():
        shutil.rmtree(out)
    work.rename(out)
    fine = sum(1 for v in tiles if v["px"] == n)
    print(f"wrote {len(tiles)} tiles ({fine} at 25 cm, {len(tiles) - fine} at 1 m), {size / 1e6:.1f} MB, to {out}")
