"""Fill `session_setup` for sessions imported before the setup was stored (vroom-1gx)."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .lmu.db import open_recording_copy
from .lmu.reader import parse_setup
from .store import AppStore


@dataclass
class BackfillResult:
    filled: list[str] = field(default_factory=list)
    skipped: list[str] = field(default_factory=list)  # already had a setup
    unreadable: list[tuple[str, str]] = field(default_factory=list)  # (session id, reason)


def read_car_setup(raw_path: Path | str) -> dict[str, str]:
    """The recording's CarSetup as setting id -> display string. The file is copied to a temp
    folder first and the copy is opened read-only. Raises `FileNotFoundError` when it's gone."""
    with open_recording_copy(raw_path) as con:
        row = con.execute("SELECT value FROM metadata WHERE key = 'CarSetup'").fetchone()
    return parse_setup(None if row is None or row[0] is None else str(row[0]))


def backfill_setups(store: AppStore) -> BackfillResult:
    """Store the setup of every session that has none, read from its raw copy. Sessions that
    already have one are never touched, so running it again changes nothing."""
    result = BackfillResult()
    for session_id, raw_path in store.session_raw_paths():
        if store.has_session_setup(session_id):
            result.skipped.append(session_id)
            continue
        try:
            setup = read_car_setup(raw_path)
        except FileNotFoundError:
            result.unreadable.append((session_id, f"raw copy missing: {raw_path}"))
            continue
        except Exception as err:  # a damaged copy must not stop the others
            result.unreadable.append((session_id, f"raw copy unreadable: {err}"))
            continue
        if not setup:
            result.unreadable.append((session_id, "no CarSetup in the recording"))
            continue
        store.add_session_setup(session_id, setup)
        result.filled.append(session_id)
    return result
