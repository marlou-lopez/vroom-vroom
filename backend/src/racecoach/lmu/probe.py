"""Describe the layout of an LMU `.duckdb` recording as Markdown."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import duckdb

from .db import open_recording_copy, qident

REGISTRY_TABLES = ("channelsList", "eventsList", "metadata")
CLOCK_CHANNEL = "GPS Time"
HEAD_TAIL_ROWS = 3
MAX_CELL = 80


def _cell(value: Any) -> str:
    text = "NULL" if value is None else str(value)
    if len(text) > MAX_CELL:
        text = text[: MAX_CELL - 1] + "…"
    return text.replace("|", "\\|").replace("\n", " ")


def _table(headers: list[str], rows: list[tuple[Any, ...]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "|" + "---|" * len(headers)]
    out += ["| " + " | ".join(_cell(v) for v in row) + " |" for row in rows]
    return out


def _count(con: duckdb.DuckDBPyConnection, table: str) -> int:
    row = con.execute(f"SELECT count(*) FROM {qident(table)}").fetchone()
    return int(row[0]) if row else 0


def _columns(con: duckdb.DuckDBPyConnection, table: str) -> list[tuple[str, str]]:
    return [(str(r[0]), str(r[1])) for r in con.execute(f"DESCRIBE {qident(table)}").fetchall()]


def probe_connection(con: duckdb.DuckDBPyConnection, name: str = "recording") -> str:
    """Build the Markdown report for an open recording connection."""
    tables = [
        str(r[0])
        for r in con.execute(
            "SELECT table_name FROM information_schema.tables "
            "WHERE table_schema = 'main' ORDER BY table_name"
        ).fetchall()
    ]
    declared: dict[str, tuple[int | None, str | None]] = {}
    if "channelsList" in tables:
        for ch, freq, unit in con.execute(
            "SELECT channelName, frequency, unit FROM channelsList"
        ).fetchall():
            declared[str(ch)] = (None if freq is None else int(freq), unit)
    event_names = (
        {str(r[0]) for r in con.execute("SELECT eventName FROM eventsList").fetchall()}
        if "eventsList" in tables
        else set()
    )

    # The recording's clock: GPS Time, one sample per tick, in seconds.
    t0 = span = None
    if CLOCK_CHANNEL in tables:
        row = con.execute(f"SELECT min(value), max(value) FROM {qident(CLOCK_CHANNEL)}").fetchone()
        if row and row[0] is not None:
            t0, span = float(row[0]), float(row[1]) - float(row[0])

    counts = {t: _count(con, t) for t in tables}
    lines = [f"# LMU recording: {name}", ""]
    lines.append(f"- Tables: {len(tables)}")
    lines.append(f"- Continuous channels (in `channelsList`): {len(declared)}")
    lines.append(f"- Event tables (in `eventsList`): {len(event_names)}")
    if t0 is not None and span is not None:
        lines.append(f"- Clock: `{CLOCK_CHANNEL}` starts at t0 = {t0:.3f} s and spans {span:.3f} s")
    lines.append("")

    lines += ["## Tables", ""]
    rows: list[tuple[Any, ...]] = []
    for t in tables:
        if t in REGISTRY_TABLES:
            kind = "registry"
        elif t in declared:
            kind = "channel"
        elif t in event_names:
            kind = "event"
        else:
            kind = "other"
        cols = ", ".join(f"{c} {ty}" for c, ty in _columns(con, t))
        rows.append((t, kind, counts[t], cols))
    lines += _table(["table", "kind", "rows", "columns"], rows)
    lines.append("")

    lines += ["## Declared vs effective rate", ""]
    lines.append(
        "Effective = rows / clock span. A channel logged at its declared rate has "
        "rows = rate × span (+1)."
    )
    lines.append("")
    rate_rows: list[tuple[Any, ...]] = []
    for ch, (freq, unit) in sorted(declared.items()):
        if ch not in counts:
            rate_rows.append((ch, freq, unit, "missing table", ""))
            continue
        eff = f"{counts[ch] / span:.2f}" if span else ""
        rate_rows.append((ch, freq, unit, counts[ch], eff))
    lines += _table(["channel", "declared Hz", "unit", "rows", "effective Hz"], rate_rows)
    lines.append("")

    lines += ["## channelsList", ""]
    lines += _table(
        ["channelName", "frequency", "unit"],
        con.execute("SELECT * FROM channelsList ORDER BY channelName").fetchall()
        if "channelsList" in tables
        else [],
    )
    lines += ["", "## eventsList", ""]
    lines += _table(
        ["eventName", "unit"],
        con.execute("SELECT * FROM eventsList ORDER BY eventName").fetchall()
        if "eventsList" in tables
        else [],
    )
    lines += ["", "## metadata", ""]
    meta = (
        con.execute("SELECT key, value FROM metadata ORDER BY key").fetchall()
        if ("metadata" in tables)
        else []
    )
    lines += _table(["key", "value"], [(k, _meta_value(str(k), v)) for k, v in meta])
    lines.append("")

    lines += ["## Head and tail rows", ""]
    for t in tables:
        if t in REGISTRY_TABLES or counts[t] == 0:
            continue
        cols = [c for c, _ in _columns(con, t)]
        head = con.execute(f"SELECT * FROM {qident(t)} LIMIT {HEAD_TAIL_ROWS}").fetchall()
        tail = con.execute(
            f"SELECT * FROM {qident(t)} OFFSET {max(counts[t] - HEAD_TAIL_ROWS, 0)}"
        ).fetchall()
        lines += [f"### {t}", ""]
        lines += _table(["", *cols], [("head", *r) for r in head] + [("tail", *r) for r in tail])
        lines.append("")
    return "\n".join(lines)


def _meta_value(key: str, value: Any) -> str:
    """CarSetup is a large JSON blob: report its size and shape, not its content."""
    if key in ("DriverName", "SteamID"):
        return "(hidden)"
    if key == "CarSetup":
        try:
            data = json.loads(str(value))
            return f"JSON object, {len(data)} keys ({len(str(value))} chars)"
        except ValueError:
            pass
    return str(value)


def probe(path: Path | str) -> str:
    """Probe a recording (read-only, on a copy) and return the Markdown report."""
    path = Path(path)
    with open_recording_copy(path) as con:
        return probe_connection(con, path.name)
