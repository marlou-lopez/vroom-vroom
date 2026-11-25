import logging
import os
import shutil
import time
from pathlib import Path

import pytest

from racecoach.store import AppStore
from racecoach.watcher import is_finished, scan_once

QUIET = 10.0


@pytest.fixture
def store(tmp_path: Path):
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s:
        yield s


def age(path: Path, seconds: float) -> None:
    t = time.time() - seconds
    os.utime(path, (t, t))


def test_is_finished(tmp_path: Path):
    f = tmp_path / "a.duckdb"
    f.write_bytes(b"x")
    assert not is_finished(f, QUIET)
    age(f, 60)
    assert is_finished(f, QUIET)
    assert not is_finished(tmp_path / "missing.duckdb", QUIET)


def test_recent_file_not_imported(store, tmp_path, spa_fixture):
    folder = tmp_path / "tel"
    folder.mkdir()
    shutil.copy(spa_fixture, folder / "rec.duckdb")
    assert scan_once(store, folder, tmp_path / "raw", QUIET) == []
    assert store.sessions() == []


def test_corrupt_or_locked_file_skipped_then_retried(store, tmp_path, spa_fixture, caplog):
    folder = tmp_path / "tel"
    folder.mkdir()
    rec = folder / "rec.duckdb"
    rec.write_bytes(b"not a duckdb file")
    age(rec, 60)
    seen = {}
    with caplog.at_level(logging.WARNING):
        assert scan_once(store, folder, tmp_path / "raw", QUIET, seen=seen) == []
    assert "rec.duckdb" in caplog.text
    assert store.sessions() == []
    shutil.copy(spa_fixture, rec)
    age(rec, 60)
    results = scan_once(store, folder, tmp_path / "raw", QUIET, seen=seen)
    assert len(results) == 1 and results[0].imported
    assert len(store.sessions()) == 1


def test_already_imported_not_reported(store, tmp_path, spa_fixture):
    folder = tmp_path / "tel"
    folder.mkdir()
    rec = folder / "rec.duckdb"
    shutil.copy(spa_fixture, rec)
    age(rec, 60)
    seen = {}
    assert len(scan_once(store, folder, tmp_path / "raw", QUIET, seen=seen)) == 1
    assert scan_once(store, folder, tmp_path / "raw", QUIET, seen=seen) == []
    # also without the cache: the store knows the sha1
    assert scan_once(store, folder, tmp_path / "raw", QUIET) == []


def test_watch_forever_imports_on_tick(store, tmp_path, spa_fixture):
    import asyncio

    from racecoach.watcher import watch_forever

    folder = tmp_path / "tel"
    folder.mkdir()
    rec = folder / "rec.duckdb"
    shutil.copy(spa_fixture, rec)
    age(rec, 60)
    got = []

    async def run() -> None:
        task = asyncio.create_task(
            watch_forever(store, folder, tmp_path / "raw", 1.0, 0.2, on_import=got.append)
        )
        for _ in range(50):
            if got:
                break
            await asyncio.sleep(0.1)
        task.cancel()

    asyncio.run(run())
    assert len(got) == 1


def test_failed_file_backs_off_until_changed(store, tmp_path, caplog):
    folder = tmp_path / "tel"
    folder.mkdir()
    rec = folder / "rec.duckdb"
    rec.write_bytes(b"junk")
    age(rec, 60)
    failed = {}
    now = time.time()
    with caplog.at_level(logging.WARNING):
        scan_once(store, folder, tmp_path / "raw", QUIET, now, failed=failed)
        scan_once(store, folder, tmp_path / "raw", QUIET, now + 5, failed=failed)
    assert caplog.text.count("Could not import") == 1
    with caplog.at_level(logging.WARNING):
        scan_once(store, folder, tmp_path / "raw", QUIET, now + 40, failed=failed)
    assert caplog.text.count("Could not import") == 2
