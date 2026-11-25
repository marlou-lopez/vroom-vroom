"""France (Le Mans, Paul Ricard): IGN BD ORTHO colour, 20 cm, Lambert-93, through the Géoplateforme WMS-Raster service.

Data: Licence Ouverte / Etalab 2.0: name IGN and the date of the data, do not suggest IGN endorses the result.
Service: the cartes.gouv.fr terms (15 Oct 2024): free, no key, at most 40 requests/s per IP on WMS-Raster, no abusive use.
The current layer follows each new flight; Le Mans was flown on 2025-07-09.
"""
from urllib.parse import urlencode

from .base import Source, http_get

URL = "https://data.geopf.fr/wms-r/wms"
TILE_M = 128


class Ign(Source):
    name = "ign_bdortho"
    crs = "EPSG:2154"
    attribution = "IGN, BD ORTHO, flown 2025-07-09 (Le Mans), Licence Ouverte 2.0 (modified: edges and kerbs extracted)"
    licence = "Licence Ouverte / Etalab 2.0"
    licence_url = "https://www.etalab.gouv.fr/licence-ouverte-open-licence/"
    source_url = "https://cartes.gouv.fr/rechercher-une-donnee/dataset/IGNF_BD-ORTHO"
    tile_px = TILE_M * 5

    def tile_of(self, x, y):
        return int(x // TILE_M), int(y // TILE_M)

    def tile_box(self, key):
        x, y = key[0] * TILE_M, key[1] * TILE_M
        return x, y, x + TILE_M, y + TILE_M

    def download(self, key):
        q = {"SERVICE": "WMS", "VERSION": "1.3.0", "REQUEST": "GetMap", "LAYERS": "ORTHOIMAGERY.ORTHOPHOTOS", "STYLES": "",
             "CRS": self.crs, "BBOX": ",".join(str(v) for v in self.tile_box(key)), "WIDTH": self.tile_px,
             "HEIGHT": self.tile_px, "FORMAT": "image/png"}
        return http_get(f"{URL}?{urlencode(q)}")


SOURCE = Ign()
