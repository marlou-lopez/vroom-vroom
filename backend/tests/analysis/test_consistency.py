import numpy as np
import pytest

from racecoach.analysis.consistency import (
    FocusItem,
    NotEnoughLaps,
    NoValidLaps,
    corner_spreads,
    evaluate_focus,
    ideal_lap,
    map_segments,
    session_consistency,
)
from racecoach.model import GRID_CHANNELS, LapKind, LapMeta, LapSource, LapTrace
from racecoach.tracks import Corner, TrackMap

TMAP = TrackMap(
    track_id="x",
    length_m=1000,
    corners=[
        Corner(id="t1", name="T1", start_m=100, apex_m=150, end_m=200),
        Corner(id="t2", name="T2", start_m=600, apex_m=650, end_m=700),
    ],
)
BOUNDS = [0, 100, 200, 600, 700, 1000]


def lap(no, durs, sectors=None, kind=LapKind.FLYING, valid=True, override=None, session="s1"):
    """A lap whose five map segments last `durs` seconds, at constant speed within each."""
    t = np.zeros(1001)
    clock = 0.0
    for (a, b), d in zip(zip(BOUNDS, BOUNDS[1:], strict=False), durs, strict=True):
        t[a : b + 1] = clock + np.linspace(0, d, b - a + 1)
        clock += d
    zeros = np.zeros(1001)
    ch = {name: zeros.copy() for name in GRID_CHANNELS}
    ch["t"] = t
    total = round(sum(durs), 3)
    meta = LapMeta(
        lap_id=f"{session}-{no}", session_id=session, lap_no=no, kind=kind, lap_time_s=total,
        sectors_s=sectors or (), valid=valid, valid_override=override, pinned_reference=False,
        source=LapSource.OWN_RECORDING, driver="d", track_id="x", car_id="c",
    )  # fmt: skip
    return meta, LapTrace(meta.lap_id, np.arange(1001, dtype=float), ch)


# segments:  S→T1, T1, T1→T2, T2, T2→Finish
A = lap(1, [10, 5.0, 20, 6.0, 15], sectors=(20, 20, 16))  # 56
B = lap(2, [10, 5.4, 19, 6.2, 16.4], sectors=(19, 21, 17))  # 57.0
C = lap(3, [10.2, 5.2, 20.4, 5.8, 15], sectors=(21, 19, 15))  # 56.6


def test_map_segments_tile_the_lap():
    segs = map_segments(TMAP)
    assert [(s.start_m, s.end_m) for s in segs] == list(zip(BOUNDS, BOUNDS[1:], strict=False))
    assert [s.corner_id for s in segs] == [None, "t1", None, "t2", None]
    assert segs[0].label == "Start → T1"
    assert segs[2].label == "T1 → T2"
    assert segs[4].label == "T2 → Finish"


def test_consistency_mean_sd_best_and_theoretical_best():
    laps = [A, B, C]
    times = [m.lap_time_s or 0.0 for m, _ in laps]
    assert times == pytest.approx([56.0, 57.0, 56.6])
    res = session_consistency(laps, TMAP)
    assert res.n_laps == 3
    assert res.mean_s == pytest.approx(np.mean(times), abs=1e-3)
    assert res.sd_s == pytest.approx(np.std(times, ddof=1), abs=1e-3)
    assert res.best_s == pytest.approx(56.0)
    # best of each sector: 19 + 19 + 15
    assert res.theoretical_best_sectors_s == pytest.approx(53.0)
    # best of each segment: 10 + 5.0 + 19 + 5.8 + 15
    assert res.theoretical_best_s == pytest.approx(54.8)
    assert res.theoretical_best_s <= res.best_s


def test_segment_minima_sum_and_come_from_the_right_lap():
    ideal = ideal_lap([A, B, C], TMAP)
    assert [s.best_s for s in ideal.segments] == pytest.approx([10, 5.0, 19, 5.8, 15])
    assert [s.lap_no for s in ideal.segments] == [1, 1, 2, 3, 1]  # earliest wins a tie
    assert ideal.time_s == pytest.approx(sum(s.best_s for s in ideal.segments), abs=1e-3)
    assert ideal.scope == "session"
    assert ideal.time_s <= min(m.lap_time_s or 0.0 for m, _ in [A, B, C])


def test_corner_spread_sorted_by_sd():
    spreads = corner_spreads([t for _, t in [A, B, C]], TMAP)
    t1 = next(s for s in spreads if s.corner_id == "t1")
    assert t1.mean_s == pytest.approx(np.mean([5.0, 5.4, 5.2]), abs=1e-3)
    assert t1.sd_s == pytest.approx(np.std([5.0, 5.4, 5.2], ddof=1), abs=1e-3)
    assert (t1.min_s, t1.max_s) == (pytest.approx(5.0), pytest.approx(5.4))
    assert [s.sd_s for s in spreads] == sorted((s.sd_s for s in spreads), reverse=True)
    assert session_consistency([A, B, C], TMAP).corners[0].corner_id == "t1"


def test_invalid_out_and_in_laps_never_count():
    bad = [
        lap(4, [1, 1, 1, 1, 1], valid=False),
        lap(5, [1, 1, 1, 1, 1], kind=LapKind.OUT),
        lap(6, [1, 1, 1, 1, 1], kind=LapKind.IN),
    ]
    res = session_consistency([A, B, *bad], TMAP)
    assert res.n_laps == 2 and res.best_s == pytest.approx(56.0)
    # a manual override makes an invalid lap count
    forced = lap(7, [9, 9, 9, 9, 9], valid=False, override=True)
    assert session_consistency([A, B, forced], TMAP).n_laps == 3
    assert ideal_lap([A, *bad], TMAP).time_s == pytest.approx(56.0)


def test_one_valid_lap_raises_not_enough_laps():
    with pytest.raises(NotEnoughLaps):
        session_consistency([A], TMAP)
    with pytest.raises(NotEnoughLaps):
        session_consistency([A, lap(2, [1, 1, 1, 1, 1], valid=False)], TMAP)
    with pytest.raises(NoValidLaps):
        ideal_lap([lap(2, [1, 1, 1, 1, 1], valid=False)], TMAP)


def test_missing_sectors_give_no_sector_theoretical_best():
    res = session_consistency([A, lap(2, [10, 5, 20, 6, 15])], TMAP)
    assert res.theoretical_best_sectors_s is None


def test_ideal_lap_scales_to_official_lap_time():
    m, tr = lap(1, [10, 5, 20, 6, 15])
    m = LapMeta(**{**m.__dict__, "lap_time_s": 57.2})  # official time is 1.2 s longer
    ideal = ideal_lap([(m, tr)], TMAP)
    assert ideal.time_s == pytest.approx(57.2, abs=2e-3)


@pytest.mark.parametrize(
    ("change", "expected"),
    [(-0.30, True), (-0.05, True), (-0.04, None), (0.0, None), (0.04, None), (0.05, False),
     (0.4, False)],  # fmt: skip
)
def test_improved_thresholds(change, expected):
    base = 5.0
    # two laps whose T1 time is baseline + change
    laps = [lap(1, [10, base + change, 20, 6, 15]), lap(2, [10, base + change, 20, 6, 15])]
    assert evaluate_focus(FocusItem("t1", "brake later", base), laps, TMAP) is expected


def test_focus_none_with_fewer_than_two_valid_laps_or_unknown_corner():
    one = [lap(1, [10, 3.0, 20, 6, 15])]  # a big improvement, but only one lap
    assert evaluate_focus(FocusItem("t1", "x", 5.0), one, TMAP) is None
    two = [*one, lap(2, [10, 3.0, 20, 6, 15], valid=False)]
    assert evaluate_focus(FocusItem("t1", "x", 5.0), two, TMAP) is None
    pair = [*one, lap(2, [10, 3, 20, 6, 15])]
    assert evaluate_focus(FocusItem("nope", "x", 5.0), pair, TMAP) is None
