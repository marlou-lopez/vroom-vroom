"""Wallonia (Spa): SPW Orthophotos 2023 summer, 25 cm, Belgian Lambert 72, through the public viewing service.

The data is CC BY 4.0. The viewing service has its own terms (free, no disproportionate use, the source stays mentioned):
a track is about 100 small images, fetched once, half a second apart.
"""
from urllib.parse import urlencode

from .base import Source, http_get

URL = "https://geoservices.wallonie.be/arcgis/rest/services/IMAGERIE/ORTHO_2023_ETE/MapServer/export"
TILE_M = 128


class Wallonia(Source):
    name = "wallonia"
    crs = "EPSG:31370"
    attribution = "Service public de Wallonie (SPW), Orthophotos 2023 Été, CC BY 4.0 (modified: edges and kerbs extracted)"
    licence = "CC BY 4.0"
    tile_px = TILE_M * 4

    def tile_of(self, x, y):
        return int(x // TILE_M), int(y // TILE_M)

    def tile_box(self, key):
        x, y = key[0] * TILE_M, key[1] * TILE_M
        return x, y, x + TILE_M, y + TILE_M

    def download(self, key):
        q = {"bbox": ",".join(str(v) for v in self.tile_box(key)), "bboxSR": 31370, "imageSR": 31370,
             "size": f"{self.tile_px},{self.tile_px}", "format": "png24", "f": "image"}
        return http_get(f"{URL}?{urlencode(q)}")


SOURCE = Wallonia()
