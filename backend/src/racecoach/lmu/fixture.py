"""Trim an LMU recording to a few laps, for a small committed test fixture."""

from __future__ import annotations

import math
from pathlib import Path

import duckdb

from .db import qident, recording_copy_path

REGISTRY_TABLES = ("channelsList", "eventsList", "metadata")
CLOCK_CHANNEL = "GPS Time"
# Lap-scoped events are cut at the window edges; every other event keeps its last
# value from before the window (re-stamped to the window start) so state is not lost.
# FLOAT channel values are rounded to this many decimals. Their noisy low bits don't
# compress: without the rounding the 3-lap fixture is 8.4 MB, not under 5 MB. 0.01 is far
# below the sensors' resolution. Position and time channels, DOUBLE columns and all events are
# kept bit for bit.
VALUE_DECIMALS = 2
EXACT_CHANNELS = frozenset(
    {
        "Lap Dist",
        "G Force Lat",
        "G Force Long",
        "G Force Vert",
        "GPS Latitude",
        "GPS Longitude",
        "GPS Time",
    }
)
# Channels in metres (suspension, ride height) span only centimetres, so they and brake force
# get 4 decimals (0.1 mm) instead. Metadata keys that identify the driver are blanked.
FINE_UNITS = frozenset({"m"})
FINE_CHANNELS = frozenset({"Brakes Force"})
FINE_DECIMALS = 4
REDACTED_METADATA = frozenset({"DriverName", "SteamID"})
LAP_EVENTS = frozenset({"Lap", "Lap Time", "Last Sector1", "Last Sector2"})


def lap_window(
    con: duckdb.DuckDBPyConnection, laps: int, first_lap: int = 1
) -> tuple[float, float]:
    """Return (start, end) in recording time for `laps` laps from the start of `first_lap`.

    Both edges sit a whole number of seconds from t0, so that every channel's slice starts on
    a sample (all rates are whole Hz) and the `t = t0 + i / frequency` rule still holds.
    """
    row = con.execute(f"SELECT min(value) FROM src.{qident(CLOCK_CHANNEL)}").fetchone()
    if not row or row[0] is None:
        raise ValueError(f"No {CLOCK_CHANNEL} samples: not an LMU recording?")
    t0 = float(row[0])
    starts = {
        int(lap): float(ts) for ts, lap in con.execute('SELECT ts, value FROM src."Lap"').fetchall()
    }
    last_lap = first_lap + laps
    if first_lap not in starts or last_lap not in starts:
        raise ValueError(
            f"Recording has laps starting at {sorted(starts)}; need {first_lap} and {last_lap}"
        )
    return (
        t0 + math.floor(starts[first_lap] - t0),
        t0 + math.ceil(starts[last_lap] - t0),
    )


def make_fixture(src: Path | str, dst: Path | str, laps: int = 3) -> Path:
    """Write a trimmed copy of `src` holding `laps` full laps to `dst` and return `dst`."""
    if laps < 1:
        raise ValueError("laps must be at least 1")
    dst = Path(dst)
    if dst.resolve() == Path(src).resolve():
        raise ValueError("dst must not be the source recording")
    dst.parent.mkdir(parents=True, exist_ok=True)
    for p in (dst, Path(f"{dst}.wal")):
        p.unlink(missing_ok=True)
    with recording_copy_path(src) as copy:
        con = duckdb.connect()
        try:
            con.execute(
                f"ATTACH '{str(dst).replace(chr(39), chr(39) * 2)}' AS out "
                "(BLOCK_SIZE 16384, STORAGE_VERSION 'latest')"
            )
            con.execute("USE out")
            con.execute(f"ATTACH '{copy}' AS src (READ_ONLY)")
            _trim(con, laps)
            con.execute("DETACH src")
            con.execute("CHECKPOINT")
        finally:
            con.close()
    return dst


def _trim(con: duckdb.DuckDBPyConnection, laps: int) -> None:
    start, end = lap_window(con, laps)
    t0_row = con.execute(f"SELECT min(value) FROM src.{qident(CLOCK_CHANNEL)}").fetchone()
    assert t0_row is not None
    t0 = float(t0_row[0])
    rates = {
        str(n): int(f)
        for n, f in con.execute("SELECT channelName, frequency FROM src.channelsList").fetchall()
    }
    units = {
        str(n): str(u)
        for n, u in con.execute("SELECT channelName, unit FROM src.channelsList").fetchall()
    }
    fine = FINE_CHANNELS | {n for n, u in units.items() if u in FINE_UNITS}
    events = {str(r[0]) for r in con.execute("SELECT eventName FROM src.eventsList").fetchall()}
    tables = [
        str(r[0])
        for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_catalog = 'src' AND table_schema = 'main'"
        ).fetchall()
    ]
    for t in tables:
        q = qident(t)
        if t in rates:
            # Samples i = 0.. sit at t = t0 + i / rate: keep those with start <= t < end.
            lo = round((start - t0) * rates[t])
            hi = round((end - t0) * rates[t])
            cols = [(str(r[0]), str(r[1])) for r in con.execute(f"DESCRIBE src.{q}").fetchall()]
            dec = FINE_DECIMALS if t in fine else VALUE_DECIMALS
            select = ", ".join(
                f"round({qident(c)}::DOUBLE, {dec})::FLOAT AS {qident(c)}"
                if c.startswith("value") and ty == "FLOAT" and t not in EXACT_CHANNELS
                else qident(c)
                for c, ty in cols
            )
            con.execute(
                f"CREATE TABLE {q} AS SELECT {select} FROM src.{q} "
                f"WHERE rowid >= {lo} AND rowid < {hi} ORDER BY rowid"
            )
        elif t in events:
            window = (
                f"SELECT 1 AS k, rowid AS r, * FROM src.{q} WHERE ts >= {start} AND ts <= {end}"
            )
            parts = [window]
            if t not in LAP_EVENTS:
                cols = [str(r[0]) for r in con.execute(f"DESCRIBE src.{q}").fetchall()]
                rest = ", ".join(qident(c) for c in cols if c != "ts")
                parts.insert(
                    0,
                    f"(SELECT 0 AS k, rowid AS r, {start}::DOUBLE AS ts, {rest} FROM src.{q} "
                    f"WHERE ts < {start} ORDER BY rowid DESC LIMIT 1)",
                )
            union = " UNION ALL ".join(f"({p})" if p is window else p for p in parts)
            con.execute(
                f"CREATE TABLE {q} AS SELECT * EXCLUDE (k, r) FROM ({union}) ORDER BY ts, k, r"
            )
        elif t == "metadata":
            con.execute(
                f"CREATE TABLE {q} AS SELECT key, "
                f"CASE WHEN key IN ({_in(REDACTED_METADATA)}) THEN '' ELSE value END AS value "
                f"FROM src.{q}"
            )
        else:
            con.execute(f"CREATE TABLE {q} AS SELECT * FROM src.{q}")


def _in(names: frozenset[str]) -> str:
    return ", ".join("'" + n.replace("'", "''") + "'" for n in sorted(names))
