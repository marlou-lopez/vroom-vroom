"""Player-only recording: blank every car's telemetry slot except the player's.

The shared-memory block holds one telemetry slot per car and each changes on every update, which
is most of the capture size. In player-only mode the logger zeroes the other slots in its copy
before storing it, so after the XOR delta and zstd they cost almost nothing. The frame size and
file format are unchanged. Scoring (all cars' positions and lap times), session and the rest are
kept as they are.

The slot offset, size and the player index/flag offsets come from the user's own LMU headers,
read at startup through layout.py (nothing from the headers is stored in this repo).
"""
from __future__ import annotations

import layout as lay

OUT = "SharedMemoryObjectOut"


class PlayerOnly:
    MODE = "player_only"

    def __init__(self, tel_offset: int, slot_size: int, slot_count: int, idx_offset: int, has_offset: int):
        self.tel_offset, self.slot_size, self.slot_count = tel_offset, slot_size, slot_count
        self.idx_offset, self.has_offset = idx_offset, has_offset
        self.tel_end = tel_offset + slot_size * slot_count
        self._zero = memoryview(bytes(slot_size * slot_count))  # preallocated; never reallocated

    def apply(self, buf: bytearray) -> None:
        """Zero all telemetry slots except the player's (all of them when there is no player)."""
        z = self._zero
        idx = buf[self.idx_offset]
        if not buf[self.has_offset] or idx >= self.slot_count:
            buf[self.tel_offset:self.tel_end] = z
            return
        a = self.tel_offset + idx * self.slot_size
        b = a + self.slot_size
        if a > self.tel_offset:
            buf[self.tel_offset:a] = z[:a - self.tel_offset]
        if b < self.tel_end:
            buf[b:self.tel_end] = z[:self.tel_end - b]

    def header(self) -> dict:
        return {"mode": self.MODE, "telemetry_offset": self.tel_offset, "telemetry_slot_size": self.slot_size,
                "telemetry_slot_count": self.slot_count, "player_index_offset": self.idx_offset,
                "player_present_offset": self.has_offset}


ALL_CARS_HEADER = {"mode": "all_cars"}


def build(region_size: int, lmu_dir=None, layout_obj: lay.Layout | None = None):
    """Returns (PlayerOnly | None, reason). `reason` says why player-only is unavailable."""
    try:
        L = layout_obj or lay.load(lmu_dir)
        size = L.sizeof(OUT)
        if size > region_size:
            return None, (f"the headers describe a {size} byte block but the game's memory is only "
                          f"{region_size} bytes (headers do not match this game version?)")
        o = L.offsetof
        count = L.record(OUT).find("telemetry")[1].type.find("telemInfo")[1].count
        slot = L.sizeof("TelemInfoV01")
        tel = o(OUT, "telemetry.telemInfo")
        if tel + slot * count > size:
            return None, "telemetry slots do not fit inside the described block"
        return PlayerOnly(tel, slot, count, o(OUT, "telemetry.playerVehicleIdx"),
                          o(OUT, "telemetry.playerHasVehicle")), ""
    except (lay.LayoutError, KeyError, OSError) as e:
        return None, str(e)
