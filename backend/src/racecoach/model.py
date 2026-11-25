"""Sim-agnostic telemetry model: sessions, laps and the 1 m distance grid.

Names and units follow the frontend contract (`frontend/src/api/types.ts`).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum

import numpy as np

# One value per metre. Mirrors GRID_CHANNELS in frontend/src/api/types.ts.
GRID_CHANNELS: tuple[str, ...] = (
    "t", "speed_kmh", "throttle", "brake", "steering", "gear", "rpm", "g_lat", "g_long",
    "yaw_rate", "lat", "lon", "path_lateral", "track_edge", "kerb",
    "susp_fl", "susp_fr", "susp_rl", "susp_rr",
    "abs", "tc", "slip_fl", "slip_fr", "slip_rl", "slip_rr",
    "wheels_off",
)  # fmt: skip


class LapKind(StrEnum):
    FLYING = "flying"
    OUT = "out"
    IN = "in"
    INCOMPLETE = "incomplete"


class LapSource(StrEnum):
    OWN_RECORDING = "own_recording"
    IMPORTED_FILE = "imported_file"
    ONLINE = "online"


def lap_id_for(session_id: str, lap_no: int) -> str:
    return f"{session_id[:12]}-{lap_no:03d}"


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


@dataclass(frozen=True, eq=False)
class Channel:
    """A time series: `t` is seconds from session start, `v` is (n,) or (n, k)."""

    t: np.ndarray
    v: np.ndarray

    def __post_init__(self) -> None:
        if self.t.ndim != 1:
            raise ValueError("Channel.t must be 1-D")
        if self.v.ndim not in (1, 2) or len(self.v) != len(self.t):
            raise ValueError(f"Channel length mismatch: t={len(self.t)}, v={self.v.shape}")


@dataclass(frozen=True)
class SessionMeta:
    session_id: str  # sha1 of the raw file
    track_name: str
    track_layout: str
    track_id: str  # slug of f"{track_name} {track_layout}"
    track_length_m: float
    car_name: str
    car_id: str
    car_class: str
    session_type: str
    game_build: str
    started_at: datetime
    driver: str
    steering_range_deg: float | None = None


@dataclass(frozen=True, eq=False)
class RawSession:
    meta: SessionMeta
    channels: dict[str, Channel]
    events: dict[str, Channel]
    setup: dict[str, str] = field(default_factory=dict)  # garage setting id -> display string


@dataclass(frozen=True)
class LapMeta:
    lap_id: str
    session_id: str
    lap_no: int
    kind: LapKind
    lap_time_s: float | None
    sectors_s: tuple[float, ...]
    valid: bool
    valid_override: bool | None
    pinned_reference: bool
    source: LapSource
    driver: str
    track_id: str
    car_id: str
    conditions: dict[str, float] = field(default_factory=dict)

    @property
    def effective_valid(self) -> bool:
        """The manual override wins over the recording's own validity."""
        return self.valid if self.valid_override is None else self.valid_override


@dataclass(frozen=True, eq=False)
class LapTrace:
    lap_id: str
    distance: np.ndarray  # metres, 1 m grid
    ch: dict[str, np.ndarray]

    def __post_init__(self) -> None:
        n = len(self.distance)
        for name, arr in self.ch.items():
            if len(arr) != n:
                raise ValueError(f"channel {name!r} has {len(arr)} samples, distance has {n}")
