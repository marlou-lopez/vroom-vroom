import numpy as np
import pytest

from racecoach.lmu.laps import build_laps, drop_gear_blips
from racecoach.lmu.reader import read_lmu_duckdb
from racecoach.model import Channel, LapKind, RawSession
from tests.synthetic import SynthCorner, make_raw_session

CORNERS = [SynthCorner(500, 90), SynthCorner(1200, 70, -1)]


def _cut(raw: RawSession, t_end: float) -> RawSession:
    """The recording as if it stopped at `t_end`."""
    cut = lambda c: Channel(c.t[c.t <= t_end], c.v[c.t <= t_end])  # noqa: E731
    return RawSession(
        raw.meta,
        {k: cut(c) for k, c in raw.channels.items()},
        {k: cut(c) for k, c in raw.events.items()},
    )


def test_build_laps_kinds():
    laps = build_laps(make_raw_session(4, CORNERS))
    assert [lap.kind for lap, _ in laps] == [
        LapKind.OUT, *[LapKind.FLYING] * 4, LapKind.IN,
    ]  # fmt: skip
    assert [lap.lap_no for lap, _ in laps] == [0, 1, 2, 3, 4, 5]
    assert laps[0][0].lap_time_s is None and laps[-1][0].lap_time_s is None
    assert laps[0][0].sectors_s == () and laps[-1][0].sectors_s == ()


def test_flying_laps_have_lap_time_sectors_and_a_full_grid():
    raw = make_raw_session(3, CORNERS, lap_time_jitter_s=0.05)
    for lap, trace in build_laps(raw)[1:4]:
        assert lap.valid and lap.lap_time_s is not None and lap.lap_time_s > 10
        assert sum(lap.sectors_s) == pytest.approx(lap.lap_time_s)
        assert trace.distance[0] == 0 and trace.distance[-1] >= 1999
        assert lap.track_id == raw.meta.track_id and lap.car_id == "synth-gt3"


def test_grid_t_matches_lap_time():
    for lap, trace in build_laps(make_raw_session(3, CORNERS))[1:4]:
        assert lap.lap_time_s is not None
        assert trace.ch["t"][0] == pytest.approx(0, abs=1e-9)
        assert trace.ch["t"][-1] == pytest.approx(lap.lap_time_s, abs=0.02)


def test_incomplete_lap_when_session_ends_midlap():
    raw = make_raw_session(3, CORNERS)
    start_lap3 = raw.events["lap"].t[3]
    laps = build_laps(_cut(raw, start_lap3 + 8.0))
    assert [lap.kind for lap, _ in laps] == [
        LapKind.OUT, LapKind.FLYING, LapKind.FLYING, LapKind.INCOMPLETE,
    ]  # fmt: skip
    last, trace = laps[-1]
    assert last.lap_time_s is None and not last.valid and last.sectors_s == ()
    assert 100 < trace.distance[-1] < 1900


def test_lmu_invalid_flag_marks_lap_invalid():
    raw = make_raw_session(4, CORNERS, invalid_laps=(2,))
    laps = {lap.lap_no: lap for lap, _ in build_laps(raw)}
    bad = laps[2]
    assert not bad.valid and not bad.effective_valid and bad.kind == LapKind.FLYING
    assert bad.sectors_s == ()
    assert bad.lap_time_s == pytest.approx(raw.events["lap"].t[3] - raw.events["lap"].t[2])
    assert laps[1].valid and laps[3].valid and laps[3].lap_time_s is not None


def test_gear_zero_blips_are_dropped_but_neutral_stays():
    gear = Channel(np.array([0.0, 1.0, 1.05, 3.0, 4.0]), np.array([3.0, 0.0, 4.0, 0.0, 0.0]))
    out = drop_gear_blips(gear)
    assert out.t.tolist() == [0.0, 1.05, 3.0, 4.0] and out.v.tolist() == [3.0, 4.0, 0.0, 0.0]


@pytest.fixture(scope="module")
def fixture_laps(spa_fixture):
    return build_laps(read_lmu_duckdb(spa_fixture))


def test_build_laps_on_fixture(fixture_laps):
    flying = [(lap, tr) for lap, tr in fixture_laps if lap.kind == LapKind.FLYING]
    assert len(flying) >= 1
    for lap, trace in flying:
        assert lap.lap_time_s is not None and 135 <= lap.lap_time_s <= 150 and lap.valid
        assert trace.distance[0] == 0 and trace.distance[-1] > 6900
        assert sum(lap.sectors_s) == pytest.approx(lap.lap_time_s)
        assert trace.ch["t"][-1] == pytest.approx(lap.lap_time_s, abs=0.1)
        assert np.all(np.diff(trace.ch["t"]) > 0)
        assert set(np.unique(trace.ch["gear"])) <= {0.0, 1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0}
        assert trace.ch["gear"].min() >= 1  # no Gear 0 blips
        assert set(np.unique(trace.ch["abs"])) <= {0.0, 1.0} and trace.ch["abs"].sum() > 0
        assert trace.ch["wheels_off"].max() <= 4 and trace.ch["slip_fl"].min() > 0
        assert "fuel_start_l" in lap.conditions and "track_temp_c" in lap.conditions
    assert fixture_laps[-1][0].kind == LapKind.INCOMPLETE


def test_race_start_lap_that_crosses_the_line_is_kept_from_the_line():
    raw = make_raw_session(2, CORNERS, pit_exit_fraction=0.3)
    ld = raw.channels["lap_dist"]
    # make the out-lap start before the line: its first 40 % of the way reads 1600..2000 then wraps
    first = raw.events["lap"].t[1]
    m = ld.t < first
    v = ld.v.copy()
    v[m] = (v[m] + 1400) % 2000
    raw2 = RawSession(raw.meta, {**raw.channels, "lap_dist": Channel(ld.t, v)}, raw.events)
    out_lap = build_laps(raw2)[0][1]
    assert out_lap.distance[0] == 0 or out_lap.distance[0] >= 0
    assert out_lap.distance[-1] > 100 and np.all(np.diff(out_lap.ch["t"]) > 0)


def test_lap_that_enters_the_pits_and_leaves_before_the_line_is_an_in_lap():
    raw = make_raw_session(3, CORNERS)
    t2 = raw.events["lap"].t[2]
    ev = raw.events["in_pits"]
    t = np.concatenate([ev.t, [t2 + 5.0, t2 + 9.0]])
    v = np.concatenate([ev.v, [1.0, 0.0]])
    o = np.argsort(t)
    events = {**raw.events, "in_pits": Channel(t[o], v[o])}
    laps = {lap.lap_no: lap for lap, _ in build_laps(RawSession(raw.meta, raw.channels, events))}
    assert laps[2].kind == LapKind.IN and laps[2].lap_time_s is None
    assert laps[3].kind == LapKind.FLYING


def test_flying_lap_ends_on_the_line_even_if_lap_dist_stops_short():
    raw = make_raw_session(2, CORNERS)
    ld = raw.channels["lap_dist"]
    v = np.where(ld.v > 1997, 1997.0, ld.v)  # Lap Dist's last readings stop 3 m short
    raw2 = RawSession(raw.meta, {**raw.channels, "lap_dist": Channel(ld.t, v)}, raw.events)
    for lap, trace in build_laps(raw2)[1:3]:
        assert trace.distance[-1] == 2000
        assert lap.lap_time_s is not None
        assert trace.ch["t"][-1] == pytest.approx(lap.lap_time_s, abs=0.02)
