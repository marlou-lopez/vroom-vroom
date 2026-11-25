"""Read an LMU `.duckdb` recording into a `RawSession` (internal names and units).

Continuous channels carry no timestamps: `t = t0 + i / freq` with `t0 = min(GPS Time)`.
Events stay raw `(ts, value)` pairs on the same clock. The original file is never opened: a
copy is (see `db.py`).
"""

from __future__ import annotations

import hashlib
import json
import re
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import duckdb
import numpy as np
import yaml

from racecoach.model import Channel, RawSession, SessionMeta, slugify

from .db import open_recording_copy, qident

DEFAULT_CARS_CONFIG = Path(__file__).resolve().parents[4] / "config" / "cars.yaml"
CLOCK_CHANNEL = "GPS Time"

# internal name -> (LMU channel, scale). Multi-column (per-wheel) channels are (n, 4), FL FR RL RR.
SCALAR_CHANNELS: dict[str, tuple[str, float]] = {
    "speed_kmh": ("Ground Speed", 1.0),  # km/h
    "throttle": ("Throttle Pos Unfiltered", 0.01),  # the driver's pedal, 0-1
    "brake": ("Brake Pos", 0.01),
    "steering": ("Steering Pos", 0.01),  # -1..1, + = right
    "rpm": ("Engine RPM", 1.0),
    "g_long": ("G Force Lat", 1.0),  # LMU's names are swapped: "Lat" is longitudinal
    "g_lat": ("G Force Long", 1.0),  # and "Long" is lateral
    "g_vert": ("G Force Vert", 1.0),
    "lat": ("GPS Latitude", 1.0),
    "lon": ("GPS Longitude", 1.0),
    "lap_dist": ("Lap Dist", 1.0),  # metres, resets at the line
    "path_lateral": ("Path Lateral", 1.0),  # m from the centreline, + = right
    "track_edge": ("Track Edge", 1.0),
    "tc": ("TC", 1.0),  # 0/1
}
WHEEL_CHANNELS: dict[str, str] = {
    "surface": "SurfaceTypes",  # enum per wheel (5 razor kerb, 6 flat kerb)
    "wheel_speed": "Wheel Speed",  # m/s
    "susp": "Susp Pos",
}
# Used for a lap's conditions; a recording without one still reads. Tyre wear is (n, 4), % left.
OPTIONAL_CHANNELS: dict[str, str] = {
    "fuel": "Fuel Level",  # litres
    "track_temp": "Track Temperature",  # C, 1 Hz
    "air_temp": "Ambient Temperature",  # C, 1 Hz
    "tyre_wear": "Tyres Wear",  # per wheel, FL FR RL RR
    # stint stats (vroom-9ki.18); per wheel unless noted
    "energy": "Virtual Energy",  # % left, 0 on a car without it
    "tyre_temp_left": "TyresTempLeft",  # tread zones, C; left/right are the car's edges
    "tyre_temp_centre": "TyresTempCentre",
    "tyre_temp_right": "TyresTempRight",
    "tyre_carcass": "TyresCarcassTemp",
    "tyre_pressure": "TyresPressure",  # kPa
    "brake_temp": "Brakes Temp",  # disc, C
}
EVENTS: dict[str, str] = {
    "gear": "Gear",
    "abs": "ABS",
    "lap": "Lap",
    "lap_time": "Lap Time",
    "last_sector1": "Last Sector1",
    "last_sector2": "Last Sector2",
    "in_pits": "In Pits",
    "current_sector": "Current Sector",
    "wetness": "Minimum Path Wetness",  # emitted on change; one row (0) on a dry day
}


def file_sha1(path: Path) -> str:
    """sha1 of the recording and, when LMU left one, its `.wal` (which holds the last rows, so
    growth in the log alone makes a different recording)."""
    h = hashlib.sha1()
    wal = path.with_name(path.name + ".wal")
    for p in (path, wal) if wal.is_file() else (path,):
        if p is wal:
            h.update(b"\0wal\0")
        with p.open("rb") as f:
            while chunk := f.read(1 << 20):
                h.update(chunk)
    return h.hexdigest()


def load_cars_config(path: Path | str | None = None) -> dict[str, Any]:
    p = Path(path) if path is not None else DEFAULT_CARS_CONFIG
    if not p.is_file():
        return {}
    data = yaml.safe_load(p.read_text(encoding="utf-8")) or {}
    return data if isinstance(data, dict) else {}


def _steer_lock_from_setup(setup_json: str | None) -> float | None:
    """`VM_STEER_LOCK.stringValue` is like "524deg (18.5deg)": take the leading number."""
    if not setup_json:
        return None
    try:
        setup = json.loads(setup_json)
        text = setup["VM_STEER_LOCK"]["stringValue"]
    except (ValueError, KeyError, TypeError):
        return None
    m = re.match(r"\s*(\d+(?:\.\d+)?)", str(text))
    return float(m.group(1)) if m and float(m.group(1)) > 0 else None


def parse_setup(setup_json: str | None) -> dict[str, str]:
    """`CarSetup` -> setting id -> display string (`stringValue`). Entries without a
    `stringValue` (`gearGraph`, `symmetric`) are dropped; bad or missing JSON gives {}."""
    if not setup_json:
        return {}
    try:
        setup = json.loads(setup_json)
    except ValueError:
        return {}
    if not isinstance(setup, dict):
        return {}
    out: dict[str, str] = {}
    for key, item in setup.items():
        if isinstance(item, dict) and isinstance(item.get("stringValue"), str):
            out[str(key)] = item["stringValue"]
    return out


def _parse_recording_time(text: str) -> datetime:
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H_%M_%SZ").replace(tzinfo=UTC)
    except ValueError:
        return datetime.fromtimestamp(0, UTC)


def _table_exists(con: duckdb.DuckDBPyConnection, name: str) -> bool:
    row = con.execute(
        "SELECT count(*) FROM information_schema.tables "
        "WHERE table_schema = 'main' AND table_name = ?",
        [name],
    ).fetchone()
    return bool(row and row[0])


def _read_series(con: duckdb.DuckDBPyConnection, table: str) -> np.ndarray:
    """All value columns as float64, shape (n,) or (n, k), in file order."""
    cols = [
        str(r[0])
        for r in con.execute(f"DESCRIBE {qident(table)}").fetchall()
        if str(r[0]).startswith("value")
    ]
    cols.sort()
    data = con.execute(
        f"SELECT {', '.join(qident(c) for c in cols)} FROM {qident(table)}"
    ).fetchnumpy()
    arr = np.column_stack([np.asarray(data[c], dtype=np.float64) for c in cols])
    return arr[:, 0] if arr.shape[1] == 1 else arr


def read_lmu_duckdb(path: Path | str, cars_config: Path | str | None = None) -> RawSession:
    """Read a recording. Raises `ValueError` when a required channel is missing."""
    path = Path(path)
    session_id = file_sha1(path)
    cars = load_cars_config(cars_config)
    with open_recording_copy(path) as con:
        meta_rows = {
            str(k): ("" if v is None else str(v))
            for k, v in con.execute("SELECT key, value FROM metadata").fetchall()
        }
        freqs = {
            str(n): float(f)
            for n, f in con.execute("SELECT channelName, frequency FROM channelsList").fetchall()
        }
        if not _table_exists(con, CLOCK_CHANNEL):
            raise ValueError(f"not an LMU recording: no {CLOCK_CHANNEL!r} table")
        gps_time = _read_series(con, CLOCK_CHANNEL)
        if len(gps_time) == 0:
            raise ValueError("recording is empty")
        t0 = float(gps_time.min())

        def channel(table: str) -> Channel:
            if not _table_exists(con, table):
                raise ValueError(f"recording has no {table!r} channel")
            v = _read_series(con, table)
            freq = freqs.get(table)
            if not freq:
                raise ValueError(f"channel {table!r} has no frequency")
            return Channel(t=t0 + np.arange(len(v)) / freq, v=v)

        channels: dict[str, Channel] = {}
        for name, (table, scale) in SCALAR_CHANNELS.items():
            ch = channel(table)
            channels[name] = Channel(ch.t, ch.v * scale) if scale != 1.0 else ch
        for name, table in WHEEL_CHANNELS.items():
            channels[name] = channel(table)
        for name, table in OPTIONAL_CHANNELS.items():
            if _table_exists(con, table) and freqs.get(table):
                channels[name] = channel(table)

        events: dict[str, Channel] = {}
        for name, table in EVENTS.items():
            if not _table_exists(con, table):
                continue
            rows = con.execute(
                f"SELECT ts, value FROM {qident(table)} WHERE ts IS NOT NULL AND value IS NOT NULL "
                "ORDER BY ts"
            ).fetchall()
            events[name] = Channel(
                t=np.array([r[0] for r in rows], dtype=np.float64),
                v=np.array([float(r[1]) for r in rows], dtype=np.float64),
            )

    car_name = meta_rows.get("CarName", "")
    car_id = (cars.get("cars") or {}).get(car_name) or slugify(car_name)
    steering = _steer_lock_from_setup(meta_rows.get("CarSetup"))
    if steering is None:
        fallback = (cars.get("steering_range_deg") or {}).get(car_id)
        steering = float(fallback) if fallback else None
    track_name = meta_rows.get("TrackName", "")
    track_layout = meta_rows.get("TrackLayout", "")
    lap_dist = channels["lap_dist"].v
    meta = SessionMeta(
        session_id=session_id,
        track_name=track_name,
        track_layout=track_layout,
        track_id=slugify(f"{track_name} {track_layout}"),
        track_length_m=float(np.nanmax(lap_dist)),
        car_name=car_name,
        car_id=car_id,
        car_class=meta_rows.get("CarClass", ""),
        session_type=meta_rows.get("SessionType", ""),
        game_build=meta_rows.get("Version", ""),
        started_at=_parse_recording_time(meta_rows.get("RecordingTime", "")),
        driver=meta_rows.get("DriverName", ""),
        steering_range_deg=steering,
    )
    return RawSession(
        meta=meta, channels=channels, events=events, setup=parse_setup(meta_rows.get("CarSetup"))
    )
