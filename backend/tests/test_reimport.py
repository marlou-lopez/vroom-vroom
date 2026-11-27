"""A recording imported while LMU was paused is replaced by its finished version (vroom-l4r)."""

import shutil
from pathlib import Path

import pytest

from racecoach.importer import import_file
from racecoach.lmu.fixture import make_fixture
from racecoach.model import LapKind
from racecoach.store import AppStore
from racecoach.watcher import scan_once

QUIET = 10.0


@pytest.fixture
def store(tmp_path: Path):
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s:
        yield s


@pytest.fixture(scope="module")
def versions(tmp_path_factory, spa_fixture) -> dict[int, Path]:
    d = tmp_path_factory.mktemp("versions")
    return {n: make_fixture(spa_fixture, d / f"v{n}.duckdb", n) for n in (1, 2)}


def _put(src: Path, dst: Path) -> Path:
    shutil.copy(src, dst)
    return dst


def test_grown_file_replaces_its_partial_import(store, tmp_path, versions, spa_fixture):
    rec = _put(versions[1], tmp_path / "rec.duckdb")
    first = import_file(store, rec, tmp_path / "raw")
    assert first.lap_count == 2
    _put(spa_fixture, rec)
    second = import_file(store, rec, tmp_path / "raw")
    assert second.imported and second.lap_count == 4
    assert [s.session_id for s in store.sessions()] == [second.session_id]
    assert len(store.laps()) == 4
    assert not (tmp_path / "raw" / f"{first.session_id}.duckdb").exists()
    assert not any(store.trace_path(f"{first.session_id[:12]}-{n:03d}").exists() for n in (1, 2))
    assert len(list((tmp_path / "traces").glob("*.parquet"))) == 4


def test_only_the_wal_grew(store, tmp_path, versions):
    import duckdb

    rec = _put(versions[1], tmp_path / "rec.duckdb")
    first = import_file(store, rec, tmp_path / "raw")
    # LMU keeps the newest rows in the .wal until a checkpoint: the main file stays the same.
    live = duckdb.connect(str(rec))
    try:
        live.execute("SET checkpoint_threshold = '10GB'")
        live.execute("CREATE TABLE only_in_wal AS SELECT 1 AS x")
        main_before = rec.read_bytes()
        wal = tmp_path / "rec.duckdb.wal"
        assert wal.is_file() and wal.stat().st_size > 0
        snapshot = tmp_path / "snap"
        snapshot.mkdir()
        shutil.copy(rec, snapshot / "rec.duckdb")
        shutil.copy(wal, snapshot / "rec.duckdb.wal")
    finally:
        live.close()
    rec.write_bytes(main_before)
    shutil.copy(snapshot / "rec.duckdb.wal", wal)
    second = import_file(store, rec, tmp_path / "raw")
    assert second.imported and second.session_id != first.session_id
    assert [s.session_id for s in store.sessions()] == [second.session_id]
    assert len(store.laps()) == 2


def test_wal_changes_the_sha1(tmp_path, versions):
    from racecoach.lmu.reader import file_sha1

    rec = _put(versions[1], tmp_path / "rec.duckdb")
    plain = file_sha1(rec)
    (tmp_path / "rec.duckdb.wal").write_bytes(b"a")
    with_wal = file_sha1(rec)
    (tmp_path / "rec.duckdb.wal").write_bytes(b"ab")
    assert len({plain, with_wal, file_sha1(rec)}) == 3


def test_wal_growth_is_a_change_for_the_watcher(store, tmp_path, versions):
    import os
    import time

    folder = tmp_path / "tel"
    folder.mkdir()
    rec = _put(versions[1], folder / "rec.duckdb")
    old = time.time() - 60
    os.utime(rec, (old, old))
    seen: dict = {}
    assert len(scan_once(store, folder, tmp_path / "raw", QUIET, seen=seen)) == 1
    wal = folder / "rec.duckdb.wal"
    wal.write_bytes(b"x")  # a fresh log: not quiet yet, so nothing happens
    assert scan_once(store, folder, tmp_path / "raw", QUIET, seen=seen) == []
    os.utime(wal, (old, old))
    from racecoach.watcher import _key

    assert seen[rec] != _key(rec)  # the cache no longer matches, so the scan looks again


def test_unchanged_file_is_not_reimported(store, tmp_path, versions):
    rec = _put(versions[1], tmp_path / "rec.duckdb")
    first = import_file(store, rec, tmp_path / "raw")
    again = import_file(store, rec, tmp_path / "raw")
    assert not again.imported and again.session_id == first.session_id
    assert len(store.sessions()) == 1


def test_failed_reimport_keeps_the_first(store, tmp_path, versions, spa_fixture, monkeypatch):
    rec = _put(versions[1], tmp_path / "rec.duckdb")
    first = import_file(store, rec, tmp_path / "raw")
    _put(spa_fixture, rec)

    def boom(*_a, **_k):
        raise RuntimeError("cannot build laps")

    monkeypatch.setattr("racecoach.importer.build_laps", boom)
    with pytest.raises(RuntimeError):
        import_file(store, rec, tmp_path / "raw")
    assert [s.session_id for s in store.sessions()] == [first.session_id]
    assert len(store.laps(first.session_id)) == 2
    assert (tmp_path / "raw" / f"{first.session_id}.duckdb").exists()
    assert len(list((tmp_path / "traces").glob("*.parquet"))) == 2
    assert len(list((tmp_path / "raw").glob("*.duckdb"))) == 1


def test_pin_and_override_survive_on_matching_laps(store, tmp_path, versions, spa_fixture):
    rec = _put(versions[2], tmp_path / "rec.duckdb")
    first = import_file(store, rec, tmp_path / "raw")
    laps = {x.lap_no: x for x in store.laps(first.session_id)}
    store.pin_reference(laps[1].lap_id)
    store.set_valid_override(laps[2].lap_id, False)
    _put(spa_fixture, rec)
    second = import_file(store, rec, tmp_path / "raw")
    new = {x.lap_no: x for x in store.laps(second.session_id)}
    assert len(new) == 4 and new[1].kind == LapKind.FLYING
    assert new[1].pinned_reference and new[1].lap_id.startswith(second.session_id[:12])
    assert new[2].valid_override is False
    assert new[3].valid_override is None and not new[3].pinned_reference
    ref = store.reference_for(new[1].track_id, new[1].car_id)
    assert ref is not None and ref.lap_id == new[1].lap_id


def test_pin_is_dropped_when_the_lap_changed(store, tmp_path, versions, spa_fixture):
    rec = _put(versions[1], tmp_path / "rec.duckdb")
    first = import_file(store, rec, tmp_path / "raw")
    partial = next(x for x in store.laps(first.session_id) if x.kind == LapKind.INCOMPLETE)
    store.pin_reference(partial.lap_id)
    _put(spa_fixture, rec)
    second = import_file(store, rec, tmp_path / "raw")
    assert not any(x.pinned_reference for x in store.laps(second.session_id))


def test_different_recordings_never_replace_each_other(store, tmp_path, versions, spa_fixture):
    a = _put(versions[1], tmp_path / "a.duckdb")
    b = _put(spa_fixture, tmp_path / "b.duckdb")
    ra = import_file(store, a, tmp_path / "raw")
    rb = import_file(store, b, tmp_path / "raw")
    assert {s.session_id for s in store.sessions()} == {ra.session_id, rb.session_id}


def test_other_content_at_the_same_path_is_kept_as_a_second_session(
    store, tmp_path, versions, spa_fixture
):
    # Fewer laps than the earlier import is not "a later, longer version".
    rec = _put(spa_fixture, tmp_path / "rec.duckdb")
    import_file(store, rec, tmp_path / "raw")
    _put(versions[1], rec)
    import_file(store, rec, tmp_path / "raw")
    assert len(store.sessions()) == 2
