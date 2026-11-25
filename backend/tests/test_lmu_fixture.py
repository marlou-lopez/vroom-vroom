from pathlib import Path

import duckdb
import pytest
from typer.testing import CliRunner

from racecoach.cli import app
from racecoach.lmu.fixture import make_fixture

MAX_BYTES = 5_000_000


def connect(path: Path) -> duckdb.DuckDBPyConnection:
    return duckdb.connect(str(path), read_only=True)


def test_committed_fixture_is_small_and_has_three_laps(spa_fixture: Path) -> None:
    assert spa_fixture.stat().st_size < MAX_BYTES
    con = connect(spa_fixture)
    laps = con.execute('SELECT value FROM "Lap" ORDER BY ts').fetchall()
    assert [v for (v,) in laps] == [1, 2, 3, 4]  # laps 1-3 in full, then lap 4 starts
    times = con.execute('SELECT value FROM "Lap Time" ORDER BY ts').fetchall()
    assert [round(v, 3) for (v,) in times] == [141.937, 142.139, 141.947]


def test_fixture_keeps_the_sample_clock_consistent(spa_fixture: Path) -> None:
    con = connect(spa_fixture)
    rates = dict(con.execute("SELECT channelName, frequency FROM channelsList").fetchall())
    t0, t1 = con.execute('SELECT min(value), max(value) FROM "GPS Time"').fetchone()  # type: ignore[misc]
    for channel, hz in rates.items():
        n = con.execute(f'SELECT count(*) FROM "{channel}"').fetchone()[0]  # type: ignore[index]
        assert n == round((t1 - t0 + 1 / rates["GPS Time"]) * hz), channel
    # Lap 1 starts inside the window, and the first lap's distance resets from ~0.
    first_lap_ts = con.execute('SELECT min(ts) FROM "Lap"').fetchone()[0]  # type: ignore[index]
    assert t0 <= first_lap_ts < t0 + 1


def test_fixture_keeps_state_events_and_metadata(spa_fixture: Path) -> None:
    con = connect(spa_fixture)
    t0 = con.execute('SELECT min(value) FROM "GPS Time"').fetchone()[0]  # type: ignore[index]
    first_in_pits = con.execute('SELECT ts, value FROM "In Pits" ORDER BY ts LIMIT 1').fetchone()
    assert first_in_pits == (t0, 0)  # pit exit state carried into the window
    meta = dict(con.execute("SELECT key, value FROM metadata").fetchall())
    assert meta["TrackName"] == "Circuit de Spa-Francorchamps"
    assert meta["CarClass"] == "GT3"


def test_make_fixture_trims_to_requested_laps(spa_fixture: Path, tmp_path: Path) -> None:
    out = make_fixture(spa_fixture, tmp_path / "one.duckdb", laps=1)
    con = connect(out)
    assert [v for (v,) in con.execute('SELECT value FROM "Lap" ORDER BY ts').fetchall()] == [1, 2]
    n = con.execute('SELECT count(*) FROM "GPS Time"').fetchone()[0]  # type: ignore[index]
    assert 14_000 < n < 15_000  # about 142 s at 100 Hz


def test_make_fixture_needs_enough_laps(spa_fixture: Path, tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="laps"):
        make_fixture(spa_fixture, tmp_path / "x.duckdb", laps=9)


def test_make_fixture_refuses_to_overwrite_the_source(spa_fixture: Path) -> None:
    with pytest.raises(ValueError):
        make_fixture(spa_fixture, spa_fixture)


def test_cli_fixture(spa_fixture: Path, tmp_path: Path) -> None:
    out = tmp_path / "f.duckdb"
    result = CliRunner().invoke(app, ["fixture", str(spa_fixture), str(out), "--laps", "2"])
    assert result.exit_code == 0, result.output
    assert out.exists()


def test_fixture_hides_driver_identity_and_keeps_metre_channels_exact(spa_fixture: Path) -> None:
    con = connect(spa_fixture)
    meta = dict(con.execute("SELECT key, value FROM metadata").fetchall())
    assert meta["DriverName"] == "" and meta["SteamID"] == ""
    distinct = con.execute('SELECT count(DISTINCT value1) FROM "Susp Pos"').fetchone()[0]  # type: ignore[index]
    assert distinct > 50  # 0.1 mm, not centimetres
