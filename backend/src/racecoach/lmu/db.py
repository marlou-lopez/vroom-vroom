"""Opening LMU recordings safely: never touch the original."""

from __future__ import annotations

import shutil
import tempfile
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

import duckdb


def copy_with_wal(src: Path, dst: Path) -> None:
    """Copy a recording and its write-ahead log, if LMU left one: rows that are only in the log
    (the last laps of a recording LMU has not checkpointed) are lost without it."""
    shutil.copy2(src, dst)
    wal = src.with_name(src.name + ".wal")
    if wal.is_file():
        shutil.copy2(wal, dst.with_name(dst.name + ".wal"))


@contextmanager
def recording_copy_path(src: Path | str) -> Generator[Path]:
    """Copy a recording to a temp folder and yield the copy's path (deleted on exit)."""
    src = Path(src)
    if not src.is_file():
        raise FileNotFoundError(src)
    with tempfile.TemporaryDirectory(prefix="racecoach-") as tmp:
        copy = Path(tmp) / "recording.duckdb"
        copy_with_wal(src, copy)
        yield copy


@contextmanager
def open_recording_copy(src: Path | str) -> Generator[duckdb.DuckDBPyConnection]:
    """Copy a recording to a temp folder and yield a read-only connection to the copy."""
    with recording_copy_path(src) as copy:
        con = duckdb.connect(str(copy), read_only=True)
        try:
            yield con
        finally:
            con.close()


def qident(name: str) -> str:
    """Quote an identifier for DuckDB SQL."""
    return '"' + name.replace('"', '""') + '"'
