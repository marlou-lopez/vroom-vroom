import hashlib
import shutil
from pathlib import Path

import duckdb
import numpy as np
import pytest

from racecoach.lmu.reader import read_lmu_duckdb

REQUIRED_CHANNELS = {
    "throttle", "brake", "steering", "speed_kmh", "rpm", "g_lat", "g_long", "g_vert",
    "lat", "lon", "lap_dist", "path_lateral", "track_edge", "surface", "tc",
    "wheel_speed", "susp",
}  # fmt: skip
REQUIRED_EVENTS = {"gear", "abs", "lap", "lap_time", "last_sector1", "last_sector2", "in_pits"}


@pytest.fixture(scope="module")
def raw(spa_fixture: Path):
    return read_lmu_duckdb(spa_fixture)


def sha1(p: Path) -> str:
    return hashlib.sha1(p.read_bytes()).hexdigest()


def test_fixture_identity(raw) -> None:
    assert "Spa" in raw.meta.track_name
    assert "720" in raw.meta.car_id or "720" in raw.meta.car_name
    assert raw.meta.car_id == "mclaren-720s-gt3-evo"
    assert raw.meta.car_class == "GT3"
    assert raw.meta.session_type == "Practice"
    assert raw.meta.started_at.year == 2026


def test_channel_times_non_decreasing_and_on_the_gps_clock(raw) -> None:
    for name, ch in {**raw.channels, **raw.events}.items():
        assert np.all(np.diff(ch.t) >= 0), name
    t0 = raw.channels["lap_dist"].t[0]
    assert raw.channels["speed_kmh"].t[0] == t0  # same t0 for every continuous channel
    assert raw.channels["speed_kmh"].t[1] - t0 == pytest.approx(0.01)
    assert raw.channels["lap_dist"].t[1] - t0 == pytest.approx(0.02)


def test_value_ranges(raw) -> None:
    ch = raw.channels
    assert 200 < np.percentile(ch["speed_kmh"].v, 99) < 300
    assert ch["lap_dist"].v.min() >= 0 and ch["lap_dist"].v.max() <= 7100
    for name in ("throttle", "brake"):
        assert ch[name].v.min() >= 0 and ch[name].v.max() <= 1, name
    assert -1 <= ch["steering"].v.min() and ch["steering"].v.max() <= 1
    assert raw.meta.track_length_m == pytest.approx(ch["lap_dist"].v.max())


def test_every_required_channel_is_present(raw) -> None:
    assert REQUIRED_CHANNELS <= raw.channels.keys()
    assert REQUIRED_EVENTS <= raw.events.keys()
    for name in ("surface", "wheel_speed", "susp"):
        assert raw.channels[name].v.shape[1] == 4, name


def test_g_channels_are_swapped(raw, spa_fixture: Path) -> None:
    con = duckdb.connect(str(spa_fixture), read_only=True)
    lmu_lat = con.execute('SELECT value FROM "G Force Lat" LIMIT 500').fetchnumpy()["value"]
    np.testing.assert_allclose(raw.channels["g_long"].v[:500], lmu_lat, rtol=1e-6)
    # braking is positive in g_long, and the car brakes harder than it accelerates
    assert raw.channels["g_long"].v.max() > 1.0


def test_source_file_is_untouched(spa_fixture: Path, tmp_path: Path) -> None:
    src = tmp_path / "rec.duckdb"
    shutil.copy2(spa_fixture, src)
    before, mtime = sha1(src), src.stat().st_mtime_ns
    raw = read_lmu_duckdb(src)
    assert sha1(src) == before and src.stat().st_mtime_ns == mtime
    assert raw.meta.session_id == before
    assert [p.name for p in tmp_path.iterdir()] == ["rec.duckdb"]  # no -wal or temp files


def test_throttle_is_unfiltered_pedal(raw) -> None:
    """Throttle Pos drops to 0 at every upshift; the driver's pedal must not."""
    gear, thr = raw.events["gear"], raw.channels["throttle"]
    # Gear passes through 0 during a shift: keep the nonzero gears and compare neighbours.
    keep = gear.v > 0
    gt, gv = gear.t[keep], gear.v[keep]
    ups = [ts for ts, a, b in zip(gt[1:], gv[:-1], gv[1:], strict=True) if b == a + 1]
    assert len(ups) >= 10
    checked = 0
    for ts in ups:
        window = thr.v[(thr.t >= ts - 0.05) & (thr.t <= ts + 0.15)]
        if window.max() > 0.9:  # pedal pinned down: the ignition cut must not show
            checked += 1
            assert window.min() > 0.5, ts
    assert checked >= 5


def _strip_steer_lock(src: Path, dst: Path) -> None:
    shutil.copy2(src, dst)
    con = duckdb.connect(str(dst))
    con.execute("UPDATE metadata SET value = '{}' WHERE key = 'CarSetup'")
    con.close()


def test_steering_range_from_car_setup(raw) -> None:
    assert raw.meta.steering_range_deg == 524


def test_steering_range_fallback_from_cars_yaml(spa_fixture: Path, tmp_path: Path) -> None:
    src = tmp_path / "nosetup.duckdb"
    _strip_steer_lock(spa_fixture, src)
    cfg = tmp_path / "cars.yaml"
    cfg.write_text(
        "cars:\n  'Garage 59 2026 #58:LM': my-car\nsteering_range_deg:\n  my-car: 480\n"
    )
    raw = read_lmu_duckdb(src, cars_config=cfg)
    assert raw.meta.car_id == "my-car"
    assert raw.meta.steering_range_deg == 480


def test_steering_range_is_none_and_car_id_slug_when_unknown(
    spa_fixture: Path, tmp_path: Path
) -> None:
    src = tmp_path / "nosetup.duckdb"
    _strip_steer_lock(spa_fixture, src)
    cfg = tmp_path / "cars.yaml"
    cfg.write_text("cars: {}\n")
    raw = read_lmu_duckdb(src, cars_config=cfg)
    assert raw.meta.steering_range_deg is None
    assert raw.meta.car_id == "garage-59-2026-58-lm"


def test_missing_file_and_non_lmu_file(tmp_path: Path) -> None:
    with pytest.raises(FileNotFoundError):
        read_lmu_duckdb(tmp_path / "nope.duckdb")
    other = tmp_path / "other.duckdb"
    con = duckdb.connect(str(other))
    con.execute("CREATE TABLE metadata(key VARCHAR, value VARCHAR)")
    con.execute("CREATE TABLE channelsList(channelName VARCHAR, frequency INT, unit VARCHAR)")
    con.close()
    with pytest.raises(ValueError, match="not an LMU recording"):
        read_lmu_duckdb(other)


def test_setup_is_key_to_display_string(raw) -> None:
    assert len(raw.setup) > 100
    assert raw.setup["VM_BRAKE_BALANCE"] == "52.2:47.8"
    assert "gearGraph" not in raw.setup


def test_setup_empty_without_car_setup(spa_fixture: Path, tmp_path: Path) -> None:
    src = tmp_path / "nosetup.duckdb"
    _strip_steer_lock(spa_fixture, src)  # CarSetup becomes "{}"
    assert read_lmu_duckdb(src).setup == {}
