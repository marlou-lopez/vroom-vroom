"""Idempotent import of an LMU recording into the app store."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from racecoach.lmu.db import copy_with_wal
from racecoach.lmu.laps import build_laps
from racecoach.lmu.reader import file_sha1, read_lmu_duckdb
from racecoach.model import LapSource
from racecoach.stint import compute_stint_stats
from racecoach.store import AppStore


@dataclass(frozen=True)
class ImportResult:
    session_id: str
    imported: bool  # False: the recording was already in the store
    lap_count: int


def import_file(
    store: AppStore,
    src: Path | str,
    raw_dir: Path | str,
    source: LapSource = LapSource.OWN_RECORDING,
    cars_config: Path | str | None = None,
) -> ImportResult:
    """sha1 -> skip if known -> copy to `raw_dir` -> read the copy -> build laps -> store.

    The original is only read (hashed and copied), never opened by DuckDB or changed.
    """
    src = Path(src)
    sha1 = file_sha1(src)
    if store.has_session(sha1):
        return ImportResult(sha1, False, len(store.laps(sha1)))
    raw_dir = Path(raw_dir)
    raw_dir.mkdir(parents=True, exist_ok=True)
    copy = raw_dir / f"{sha1}.duckdb"
    made_copy = not copy.exists()
    if made_copy:
        tmp = copy.with_suffix(".part")
        copy_with_wal(src, tmp)
        tmp.replace(copy)
        if tmp.with_name(tmp.name + ".wal").exists():
            tmp.with_name(tmp.name + ".wal").replace(copy.with_name(copy.name + ".wal"))
    try:
        raw = read_lmu_duckdb(copy, cars_config)
        if raw.meta.session_id != sha1:
            raise RuntimeError(f"{src} changed while it was being imported; try again")
        laps = build_laps(raw, source)
        stats = compute_stint_stats(raw, [lap for lap, _ in laps])
        store.add_session(raw.meta, laps, copy, stats)
    except BaseException:
        if made_copy:
            copy.unlink(missing_ok=True)
            copy.with_name(copy.name + ".wal").unlink(missing_ok=True)
        raise
    return ImportResult(raw.meta.session_id, True, len(laps))
