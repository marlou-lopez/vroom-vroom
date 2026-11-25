"""The adapter interface: a source cuts the world into tiles of its own projection and downloads one tile at a time.

A new source is one file with a subclass of Source and a module-level SOURCE. Everything else (which tiles the corridor
needs, caching, politeness, sampling) is done here and in build.py, so an adapter only answers three questions:
which tile holds a point, where a tile lies, and how to download it.
"""
from __future__ import annotations

import io
import time
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image

USER_AGENT = "aerial-edges/0.1"
PAUSE_S = 0.5  # between downloads: these are public viewing services, not bulk ones


def http_get(url: str, tries: int = 4) -> bytes:
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=90) as r:
                data = r.read()
            time.sleep(PAUSE_S)
            return data
        except (urllib.error.URLError, TimeoutError):
            if k == tries - 1:
                raise
            time.sleep(5 * 2**k)
    raise AssertionError


class Source:
    name: str
    crs: str  # a pyproj name, e.g. "EPSG:31370"
    attribution: str  # shown wherever data derived from this imagery is drawn
    licence: str
    licence_url: str = ""
    source_url: str = ""
    tile_px: int

    def tile_of(self, x: float, y: float) -> tuple[int, int]:
        """The tile holding a point of the source's projection."""
        raise NotImplementedError

    def tile_box(self, key: tuple[int, int]) -> tuple[float, float, float, float]:
        """(xmin, ymin, xmax, ymax) of a tile in the source's projection; row 0 is the north side."""
        raise NotImplementedError

    def download(self, key: tuple[int, int]) -> bytes:
        """One tile as an encoded image of tile_px x tile_px."""
        raise NotImplementedError

    # ---- shared

    def fetch(self, key: tuple[int, int], cache: Path) -> np.ndarray:
        f = cache / self.name / f"{key[0]}_{key[1]}.img"
        if not f.exists():
            data = self.download(key)
            Image.open(io.BytesIO(data)).verify()
            f.parent.mkdir(parents=True, exist_ok=True)
            f.write_bytes(data)
        a = np.asarray(Image.open(f).convert("RGB"))
        if a.shape[:2] != (self.tile_px, self.tile_px):
            raise SystemExit(f"{f}: {a.shape}, expected {self.tile_px} px square")
        return a

    def sample(self, x: np.ndarray, y: np.ndarray, cache: Path) -> tuple[np.ndarray, int]:
        """Bilinear RGB (float32) at points of the source's projection, and how many tiles that took."""
        out = np.zeros(x.shape + (3,), np.float32)
        keys: dict[tuple[int, int], np.ndarray] = {}
        for k in {self.tile_of(a, b) for a, b in zip(x.ravel()[::7], y.ravel()[::7])}:
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    keys.setdefault((k[0] + dx, k[1] + dy))  # type: ignore[arg-type]
        n = 0
        for key in sorted(keys):
            x0, y0, x1, y1 = self.tile_box(key)
            m = (x >= x0) & (x < x1) & (y >= y0) & (y < y1)
            if not m.any():
                continue
            img = np.pad(self.fetch(key, cache).astype(np.float32), ((1, 1), (1, 1), (0, 0)), mode="edge")
            n += 1
            px = (x[m] - x0) / (x1 - x0) * self.tile_px + 0.5
            py = (y1 - y[m]) / (y1 - y0) * self.tile_px + 0.5
            ix, iy = np.floor(px).astype(int), np.floor(py).astype(int)
            ix, iy = np.clip(ix, 0, self.tile_px), np.clip(iy, 0, self.tile_px)
            fx, fy = (px - ix)[:, None], (py - iy)[:, None]
            out[m] = (img[iy, ix] * (1 - fx) + img[iy, ix + 1] * fx) * (1 - fy) + (
                img[iy + 1, ix] * (1 - fx) + img[iy + 1, ix + 1] * fx) * fy
        return out, n
