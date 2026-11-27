"""Backfilling session_setup from the raw copies (vroom-1gx)."""

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from typer.testing import CliRunner

from racecoach.api.app import create_app
from racecoach.cli import app as cli_app
from racecoach.importer import import_file
from racecoach.settings import Settings
from racecoach.setup_backfill import backfill_setups
from racecoach.store import AppStore


@pytest.fixture
def store(tmp_path: Path):
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s:
        yield s


def _entries(store: AppStore, tmp_path: Path, sid: str) -> list[dict]:
    settings = Settings(data_dir=tmp_path)
    with TestClient(create_app(settings, store, frontend_dist=None, watch=False)) as c:
        return c.get(f"/api/sessions/{sid}/setup").json()["entries"]


def test_backfill_restores_what_import_stored(store, tmp_path, spa_fixture):
    sid = import_file(store, spa_fixture, tmp_path / "raw").session_id
    before = _entries(store, tmp_path, sid)
    assert len(before) > 100
    store.con.execute("DELETE FROM session_setup")
    assert _entries(store, tmp_path, sid) == []

    result = backfill_setups(store)
    assert (result.filled, result.skipped, result.unreadable) == ([sid], [], [])
    assert _entries(store, tmp_path, sid) == before


def test_backfill_is_idempotent_and_never_overwrites(store, tmp_path, spa_fixture):
    sid = import_file(store, spa_fixture, tmp_path / "raw").session_id
    store.con.execute("UPDATE session_setup SET entries = '{\"X\": \"kept\"}'")
    result = backfill_setups(store)
    assert (result.filled, result.skipped) == ([], [sid])
    assert store.session_setup(sid) == {"X": "kept"}

    store.con.execute("DELETE FROM session_setup")
    assert len(backfill_setups(store).filled) == 1
    again = backfill_setups(store)
    assert (again.filled, again.skipped) == ([], [sid])


def test_missing_raw_file_is_reported_and_skipped(store, tmp_path, spa_fixture):
    sid = import_file(store, spa_fixture, tmp_path / "raw").session_id
    store.con.execute("DELETE FROM session_setup")
    (tmp_path / "raw" / f"{sid}.duckdb").unlink()
    result = backfill_setups(store)
    assert result.filled == [] and result.skipped == []
    assert len(result.unreadable) == 1 and "missing" in result.unreadable[0][1]
    assert store.session_setup(sid) == {}


def test_raw_copy_is_not_modified(store, tmp_path, spa_fixture):
    sid = import_file(store, spa_fixture, tmp_path / "raw").session_id
    store.con.execute("DELETE FROM session_setup")
    raw = tmp_path / "raw" / f"{sid}.duckdb"
    before = raw.read_bytes()
    backfill_setups(store)
    assert raw.read_bytes() == before
    assert sorted(p.name for p in raw.parent.iterdir()) == [raw.name]  # no sidecar files


def test_cli_prints_the_counts(tmp_path, spa_fixture, monkeypatch):
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s:
        import_file(s, spa_fixture, tmp_path / "raw")
        s.con.execute("DELETE FROM session_setup")
    monkeypatch.setenv("RACECOACH_DATA_DIR", str(tmp_path))
    out = CliRunner().invoke(cli_app, ["setup", "backfill"])
    assert out.exit_code == 0, out.output
    assert "filled 1, skipped 0 (already had a setup), could not read 0" in out.output
    out = CliRunner().invoke(cli_app, ["setup", "backfill"])
    assert "filled 0, skipped 1" in out.output
