"""Northern Italy (Monza): AGEA national orthophoto 2024, open WMTS tiles, zoom 18 (0.42 m at Monza), web Mercator.

CC BY 4.0. The 20 cm download needs an email address and a captcha, so it is not automated here. The 2022 and 2023
flights (Imola is 2023) are the same service with another year in the URL.
"""
import math

from .base import Source, http_get

ZOOM = 18
HALF = 20037508.342787
TILE = 2 * HALF / 2**ZOOM


class Agea(Source):
    crs = "EPSG:3857"
    licence = "CC BY 4.0"
    tile_px = 256

    def __init__(self, year: int):
        self.name = f"agea_{year}"
        self.attribution = f"AGEA, Ortofoto {year}, CC BY 4.0 (modified: edges and kerbs extracted)"
        self.url = f"https://geoportale.agea.gov.it/image/rest/services/AgEA/Ortofoto_AgEA_{year}/ImageServer/tile/{ZOOM}"

    def tile_of(self, x, y):
        return math.floor((x + HALF) / TILE), math.floor((HALF - y) / TILE)

    def tile_box(self, key):
        x, y = key[0] * TILE - HALF, HALF - (key[1] + 1) * TILE
        return x, y, x + TILE, y + TILE

    def download(self, key):
        return http_get(f"{self.url}/{key[1]}/{key[0]}")


SOURCE = Agea(2024)
