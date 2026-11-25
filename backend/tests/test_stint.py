import json
import os
from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest

from racecoach.importer import import_file
from racecoach.lmu.laps import build_laps
from racecoach.lmu.reader import read_lmu_duckdb
from racecoach.model import Channel, LapKind, RawSession
from racecoach.stint import (
    Stint,
    StintLap,
    Wheels,
    compute_stint_stats,
    session_stints,
    split_stints,
)
from racecoach.store import AppStore
from tests.synthetic import SynthCorner, make_raw_session

CORNERS = [SynthCorner(500, 90), SynthCorner(1200, 70, -1)]


def _series(raw: RawSession, fn, hz: float, width: int | None = None) -> Channel:
    end = float(raw.channels["speed_kmh"].t[-1])
    t = np.arange(0.0, end, 1.0 / hz)
    v = np.array([fn(x) for x in t], dtype=float)
    return Channel(t, v if width is None else np.repeat(v[:, None], width, axis=1))


def _with_stint_channels(raw: RawSession, refuel_at: float | None = None) -> RawSession:
    """Fuel burns 0.05 L/s (a refuel at `refuel_at` adds 40 L); wear 0.01 %/s; tyres 80 C."""

    def fuel(t: float) -> float:
        return 60.0 - 0.05 * t + (40.0 if refuel_at is not None and t >= refuel_at else 0.0)

    ch = dict(raw.channels)
    ch["fuel"] = _series(raw, fuel, 20)
    ch["energy"] = _series(raw, lambda t: 100.0 - 0.1 * t, 20)
    ch["tyre_wear"] = _series(raw, lambda t: 100.0 - 0.01 * t, 10, 4)
    ch["tyre_temp_left"] = _series(raw, lambda t: 70.0, 100, 4)
    ch["tyre_temp_centre"] = _series(raw, lambda t: 80.0, 100, 4)
    ch["tyre_temp_right"] = _series(raw, lambda t: 90.0, 100, 4)
    ch["tyre_carcass"] = _series(raw, lambda t: 83.0, 5, 4)
    ch["tyre_pressure"] = _series(raw, lambda t: 170.0, 10, 4)
    ch["brake_temp"] = _series(raw, lambda t: 400.0, 50, 4)
    ch["track_temp"] = _series(raw, lambda t: 30.0, 1)
    ch["air_temp"] = _series(raw, lambda t: 20.0, 1)
    return replace(raw, channels=ch)


@pytest.fixture
def raw() -> RawSession:
    return _with_stint_channels(make_raw_session(4, CORNERS, invalid_laps=(2,)))


def test_stats_per_lap(raw: RawSession):
    laps = [lap for lap, _ in build_laps(raw)]
    stats = compute_stint_stats(raw, laps)
    assert set(stats) == {lap.lap_id for lap in laps}
    by_no = {lap.lap_no: stats[lap.lap_id] for lap in laps}
    assert by_no[0]["kind"] == "out"
    assert by_no[1]["kind"] == "flying"
    assert by_no[len(by_no) - 1]["kind"] == "in"
    flying = by_no[1]
    dur = float(raw.events["lap"].t[2] - raw.events["lap"].t[1])
    assert flying["fuel_start_l"] - flying["fuel_end_l"] == pytest.approx(0.05 * dur, abs=0.1)
    assert flying["energy_start_pct"] == pytest.approx(100 - 0.1 * raw.events["lap"].t[1], abs=0.02)
    assert flying["tyre_surface_c"] == {w: 80.0 for w in ("fl", "fr", "rl", "rr")}
    assert flying["tyre_zones_c"]["left"]["rr"] == 70.0
    assert flying["tyre_zones_c"]["right"]["fl"] == 90.0
    assert flying["tyre_carcass_c"]["fl"] == 83.0
    assert flying["tyre_pressure_kpa"]["rl"] == 170.0
    assert flying["brake_c"]["fr"] == 400.0
    assert (flying["track_temp_c"], flying["air_temp_c"]) == (30.0, 20.0)
    assert flying["lap_time_s"] == pytest.approx(dur, abs=0.01) and flying["valid"] is True
    assert 99.0 < flying["tyre_wear_end_pct"]["fl"] < 100.0


def test_invalid_lap_has_time_zero_and_is_not_valid(raw: RawSession):
    laps = [lap for lap, _ in build_laps(raw)]
    stats = compute_stint_stats(raw, laps)
    bad = next(stats[lap.lap_id] for lap in laps if lap.lap_no == 2)
    assert bad["lap_time_s"] == 0.0 and bad["valid"] is False


def test_out_and_in_laps_have_no_lap_time_when_not_timed(raw: RawSession):
    laps = [lap for lap, _ in build_laps(raw)]
    stats = compute_stint_stats(raw, laps)
    last = max(laps, key=lambda lap: lap.lap_no)
    assert stats[last.lap_id]["lap_time_s"] is None  # the recording ends in the pits


def test_energy_is_null_on_a_car_without_it():
    base = make_raw_session(2, CORNERS)
    raw = _with_stint_channels(base)
    ch = dict(raw.channels)
    ch["energy"] = _series(raw, lambda t: 0.0, 20)
    raw = replace(raw, channels=ch)
    stats = compute_stint_stats(raw, [lap for lap, _ in build_laps(raw)])
    assert all(
        s["energy_start_pct"] is None and s["energy_end_pct"] is None for s in stats.values()
    )


def test_no_stats_without_stint_channels():
    raw = make_raw_session(2, CORNERS)
    assert compute_stint_stats(raw, [lap for lap, _ in build_laps(raw)]) == {}


def test_refuelling_shows_as_fuel_rising_between_laps():
    raw0 = make_raw_session(4, CORNERS)
    stop = float(raw0.events["lap"].t[3])  # the stop happens at the start of lap 3
    raw = _with_stint_channels(raw0, refuel_at=stop - 0.1)  # after lap 2's last sample
    laps = [lap for lap, _ in build_laps(raw)]
    stats = compute_stint_stats(raw, laps)
    by_no = {lap.lap_no: stats[lap.lap_id] for lap in laps}
    assert by_no[3]["fuel_start_l"] > by_no[2]["fuel_end_l"] + 30


def test_pit_stop_with_refuel_in_the_middle_gives_two_stints(tmp_path: Path):
    raw0 = make_raw_session(5, CORNERS, invalid_laps=(1,))
    lap_t = raw0.events["lap"].t
    stop_in, stop_out = float(lap_t[3]) - 0.5, float(lap_t[3]) + 0.02  # in lap 2, out lap 3
    pits = raw0.events["in_pits"]
    keep = (pits.t < stop_in - 1) | (pits.t > float(lap_t[-1]))
    pit_t = np.concatenate([pits.t[keep][:2], [stop_in, stop_out], pits.t[keep][2:]])
    pit_v = np.concatenate([pits.v[keep][:2], [1.0, 0.0], pits.v[keep][2:]])
    raw = _with_stint_channels(
        replace(raw0, events={**raw0.events, "in_pits": Channel(pit_t, pit_v)}),
        refuel_at=float(lap_t[3]) - 0.1,
    )
    laps = build_laps(raw)
    stats = compute_stint_stats(raw, [lap for lap, _ in laps])
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as store:
        store.add_session(raw.meta, laps, "raw.duckdb", stats)
        stints = session_stints(store, raw.meta.session_id)
    assert len(stints) == 2  # the final in lap ends the second stint
    first, second = stints[0], stints[1]
    assert first.laps[-1].lap_no == 2 and first.laps[-1].kind == LapKind.IN
    assert second.laps[0].lap_no == 3 and second.laps[0].kind == LapKind.OUT
    assert second.laps[0].fuel_start_l > first.laps[-1].fuel_end_l + 30  # refuelled
    assert any(not lap.valid for lap in first.laps)  # the invalid lap stays in its stint


def _lap(no: int, kind: LapKind) -> StintLap:
    w = Wheels(fl=1, fr=1, rl=1, rr=1)
    from racecoach.stint import TyreZones

    return StintLap(
        lap_id=f"s-{no:03d}", lap_no=no, kind=kind, lap_time_s=90.0, valid=True, fuel_start_l=50,
        fuel_end_l=48, energy_start_pct=None, energy_end_pct=None, tyre_surface_c=w,
        tyre_zones_c=TyreZones(left=w, centre=w, right=w), tyre_carcass_c=w,
        tyre_pressure_kpa=w, tyre_wear_end_pct=w, brake_c=w, track_temp_c=30, air_temp_c=20,
    )  # fmt: skip


def test_split_after_each_in_lap():
    kinds = ["out", "flying", "in", "out", "flying", "flying", "in", "out", "incomplete"]
    stints = split_stints([_lap(i, LapKind(k)) for i, k in enumerate(kinds)])
    assert [s.stint_no for s in stints] == [1, 2, 3]
    assert [[lap.lap_no for lap in s.laps] for s in stints] == [[0, 1, 2], [3, 4, 5, 6], [7, 8]]
    assert stints[1].laps[0].kind == LapKind.OUT and stints[0].laps[-1].kind == LapKind.IN
    assert all(s.falloff is None for s in stints)


def test_split_keeps_invalid_laps_and_handles_no_stop():
    laps = [_lap(0, LapKind.OUT), _lap(1, LapKind.FLYING), _lap(2, LapKind.FLYING)]
    laps[1] = laps[1].model_copy(update={"valid": False, "lap_time_s": 0.0})
    stints = split_stints(laps)
    assert len(stints) == 1 and stints[0].laps[1].valid is False
    assert split_stints([]) == []


def test_session_stints_from_the_store(tmp_path: Path, raw: RawSession):
    laps = build_laps(raw)
    stats = compute_stint_stats(raw, [lap for lap, _ in laps])
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as store:
        store.add_session(raw.meta, laps, "raw.duckdb", stats)
        stints = session_stints(store, raw.meta.session_id)
        assert len(stints) == 1
        assert [lap.lap_no for lap in stints[0].laps] == [lap.lap_no for lap, _ in laps]
        # validates against the contract shape
        body = [s.model_dump(mode="json") for s in stints]
        assert Stint.model_validate(body[0]) == stints[0]
        assert set(body[0]) == {"stint_no", "laps", "falloff", "falloff_fuel_corrected"}
        assert body[0]["laps"][0]["kind"] == "out"
        assert set(body[0]["laps"][0]) == {
            "lap_id", "lap_no", "kind", "lap_time_s", "valid", "fuel_start_l", "fuel_end_l",
            "energy_start_pct", "energy_end_pct", "tyre_surface_c", "tyre_zones_c",
            "tyre_carcass_c", "tyre_pressure_kpa", "tyre_wear_end_pct", "brake_c",
            "track_temp_c", "air_temp_c",
        }  # fmt: skip
        with pytest.raises(KeyError):
            session_stints(store, "nope")


def test_session_without_stats_has_no_stints(tmp_path: Path):
    raw = make_raw_session(2, CORNERS)
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as store:
        store.add_session(raw.meta, build_laps(raw), "raw.duckdb")
        assert session_stints(store, raw.meta.session_id) == []


def test_fixture_import_gives_stints(tmp_path: Path, spa_fixture: Path):
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as store:
        res = import_file(store, spa_fixture, tmp_path / "raw")
        stints = session_stints(store, res.session_id)
        assert stints and sum(len(s.laps) for s in stints) == res.lap_count
        lap = stints[0].laps[1]
        assert lap.fuel_start_l > lap.fuel_end_l > 0
        assert read_lmu_duckdb(spa_fixture).meta.session_id == res.session_id


def test_wal_next_to_a_recording_is_copied(tmp_path: Path):
    from racecoach.lmu.db import copy_with_wal

    src = tmp_path / "a.duckdb"
    src.write_bytes(b"db")
    (tmp_path / "a.duckdb.wal").write_bytes(b"wal")
    copy_with_wal(src, tmp_path / "b.duckdb")
    assert (tmp_path / "b.duckdb.wal").read_bytes() == b"wal"


MOCK = Path(__file__).parents[2] / "frontend/public/mock/monza-stint-2026-11-09.json"


@pytest.mark.skipif(
    "RACECOACH_MONZA_RACE" not in os.environ, reason="needs the Monza race recording of 2026-11-09"
)
def test_matches_the_mock_on_the_monza_race():
    """Set RACECOACH_MONZA_RACE to the recording (its .wal beside it) to check the port."""
    raw = read_lmu_duckdb(os.environ["RACECOACH_MONZA_RACE"])
    laps = [lap for lap, _ in build_laps(raw)]
    stats = compute_stint_stats(raw, laps)
    ref = json.loads(MOCK.read_text())["laps"]
    assert [lap.lap_no for lap in laps] == [r["lap_no"] for r in ref]
    for lap, r in zip(laps, ref, strict=True):
        assert stats[lap.lap_id] == {k: r[k] for k in stats[lap.lap_id]}
