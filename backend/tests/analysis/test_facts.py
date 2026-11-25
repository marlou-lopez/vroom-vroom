import numpy as np
import pytest

from racecoach.analysis.balance import (
    BalanceTrace,
    balance_runs,
    compare_balance,
    corner_understeer,
    fit_balance,
)
from racecoach.analysis.delta import corner_delta, delta_time
from racecoach.analysis.facts import corner_facts, lap_facts, phase_losses
from racecoach.analysis.metrics import corner_side, steering_extrema
from racecoach.tracks import Corner, Landmark, TrackMap
from tests.synthetic import SynthCorner, make_lap

APEXES = [500, 1100, 1600]
CORNERS = [SynthCorner(a, 90) for a in APEXES]
TMAP = TrackMap(
    track_id="x",
    length_m=2000,
    corners=[
        Corner(id=f"t{i + 1}", name=f"T{i + 1}", start_m=a - 200, apex_m=a, end_m=a + 150)
        for i, a in enumerate(APEXES)
    ],
)


def test_identical_laps_zero_delta_and_zero_diffs():
    lap, ref = make_lap(CORNERS), make_lap(CORNERS, lap_id="R")
    assert np.allclose(delta_time(lap, ref), 0)
    facts = lap_facts(TMAP, lap, ref)
    assert facts.total_delta_s == 0
    for c in facts.corners:
        assert c.delta_s == 0
        assert (c.phases.entry_s, c.phases.mid_s, c.phases.exit_s) == (0, 0, 0)
        assert c.steer_extra == 0
        assert c.lap == c.ref
    assert all(s.delta_s == 0 for s in facts.straights)


def test_early_braking_shows_in_entry_phase():
    ref = make_lap(CORNERS, lap_id="R")
    lap = make_lap(CORNERS, brake_shift_m=-30)  # reaches the minimum speed 30 m before the apex
    delta = delta_time(lap, ref)
    p = phase_losses(delta, TMAP.corners[0])
    assert p.entry_s > 0.05
    assert p.entry_s > 5 * (abs(p.mid_s) + abs(p.exit_s))
    f = corner_facts(TMAP.corners[0], lap, ref, delta)
    assert f.lap.brake_onset_m is not None and f.ref.brake_onset_m is not None
    assert f.lap.brake_onset_m < f.ref.brake_onset_m
    assert f.delta_s == pytest.approx(p.entry_s + p.mid_s + p.exit_s, abs=0.002)


def test_lower_min_speed_detected():
    ref = make_lap(CORNERS, lap_id="R")
    lap = make_lap(CORNERS, min_speed_delta_kmh=-12)
    f = corner_facts(TMAP.corners[1], lap, ref, delta_time(lap, ref))
    assert f.ref.min_speed_kmh - f.lap.min_speed_kmh == pytest.approx(12, abs=0.5)
    assert f.delta_s > 0


def test_corner_plus_straight_deltas_sum_to_total():
    ref = make_lap(CORNERS, lap_id="R")
    lap = make_lap(CORNERS, brake_shift_m=-20, min_speed_delta_kmh=-6, top_kmh=245)
    facts = lap_facts(TMAP, lap, ref)
    assert facts.total_delta_s > 0
    total = sum(c.delta_s for c in facts.corners) + sum(s.delta_s for s in facts.straights)
    assert total == pytest.approx(facts.total_delta_s, abs=0.001)


def test_wrapping_corner_is_measured_across_the_line():
    ref = make_lap([SynthCorner(1990, 90)], lap_id="R")
    lap = make_lap([SynthCorner(1990, 80)])
    wrap = Corner(id="w", name="W", start_m=1900, apex_m=1990, end_m=60)
    delta = delta_time(lap, ref)
    side = corner_side(lap, wrap)
    assert side.min_speed_m > 1800 or side.min_speed_m < 100
    assert corner_delta(delta, wrap) > 0
    other = Corner(id="o", name="O", start_m=60, apex_m=500, end_m=1900)
    total = corner_delta(delta, wrap) + corner_delta(delta, other)
    assert total == pytest.approx(delta[-1] - delta[0], abs=0.001)


def test_flat_corner_has_no_brake_metrics():
    lap = make_lap([SynthCorner(500, 250)], lap_id="L")
    ref = make_lap([SynthCorner(500, 250)], lap_id="R")
    c = Corner(id="t1", name="T1", start_m=400, apex_m=500, end_m=650)
    f = corner_facts(c, lap, ref, delta_time(lap, ref))
    assert f.flat
    for side in (f.lap, f.ref):
        assert side.brake_onset_m is None
        assert side.release_point_m is None
        assert side.trail_release_rate is None
    assert f.cues.brake_lap is None


def test_braking_corner_has_brake_metrics():
    lap = make_lap(CORNERS)
    side = corner_side(lap, TMAP.corners[0])
    assert side.peak_brake > 0.5
    assert side.brake_onset_m is not None and side.brake_onset_m < 500
    assert side.release_point_m is not None and side.release_point_m <= 505
    assert side.trail_release_rate is not None and side.trail_release_rate > 0
    assert side.throttle_pickup_m is not None and side.throttle_pickup_m >= side.min_speed_m
    assert side.full_throttle_m is not None and side.full_throttle_m >= side.throttle_pickup_m
    assert side.gear_at_apex is not None and side.gear_at_apex >= 1
    assert side.understeer_peak_deg_s is None and side.balance_ratio is None


def test_lap_facts_sorted_by_loss():
    ref = make_lap(CORNERS, lap_id="R")
    lap = make_lap(
        [SynthCorner(500, 90), SynthCorner(1100, 70), SynthCorner(1600, 82)], lap_id="L"
    )
    facts = lap_facts(TMAP, lap, ref)
    losses = [c.delta_s for c in facts.corners]
    assert losses == sorted(losses, reverse=True)
    assert facts.corners[0].corner_id == "t2"


def test_cues_use_landmarks_never_metres():
    lap = make_lap(CORNERS)
    ref = make_lap(CORNERS, lap_id="R")
    side = corner_side(ref, TMAP.corners[0])
    assert side.brake_onset_m is not None
    board = Landmark(
        id="b", label="T1 brake board", kind="brake_board",
        distance_m=side.brake_onset_m + 5, corner_id="t1", confidence="detected",
    )  # fmt: skip
    f = corner_facts(TMAP.corners[0], lap, ref, delta_time(lap, ref), [board], length_m=2000)
    assert f.cues.brake_ref == "just before the T1 brake board" or f.cues.brake_ref == (
        "at the T1 brake board"
    )


def test_steering_extrema_counts_reversals():
    n = 600
    steer = np.zeros(n)
    steer[200:300] = 0.6
    steer[300:360] = -0.3
    steer[360:420] = 0.5
    c = Corner(id="c", name="C", start_m=150, apex_m=250, end_m=450)
    assert steering_extrema(steer, c) == 3
    assert steering_extrema(np.zeros(n), c) == 0


def test_corner_understeer_peak_and_mean():
    bal = np.full(100, np.nan)
    bal[10:20] = [0, 2, 6, 8, 4, 1, -3, 7, 3, 0]
    c = Corner(id="c", name="C", start_m=5, apex_m=15, end_m=30)
    assert corner_understeer(bal, c) == (8.0, 7.0)
    assert corner_understeer(np.full(100, np.nan), c) is None
    assert corner_understeer(None, c) is None


def _lap_with_understeer():
    lap = make_lap(CORNERS)
    return lap


def test_balance_fit_and_usual_balance_is_zero():
    lap = _lap_with_understeer()
    lb, rb = compare_balance(lap, lap, 524.0, 524.0, same_car=True)
    assert lb is not None and rb is not None
    finite = lb.balance[np.isfinite(lb.balance)]
    assert len(finite) > 0
    assert abs(float(np.median(finite))) < 5
    assert len(lb.for_api()) == len(lap.distance)
    # no steering range: no balance
    assert compare_balance(lap, lap, None, None, same_car=True) == (None, None)
    assert fit_balance([lap], 524.0) is not None


def test_balance_runs_need_corner_and_length():
    lap = make_lap(CORNERS)
    n = len(lap.distance)
    bal = np.zeros(n)
    bal[495:510] = 9.0  # in the corner (g_lat 1.5)
    bal[900:903] = 9.0  # too short, and on a straight
    nan = np.full(n, np.nan)
    under, over = balance_runs(lap, BalanceTrace(bal, nan, nan))
    assert under == [(495, 509)]
    assert over == []


def test_adjacent_corners_and_wrapping_corner_still_sum_to_total():
    ref = make_lap(CORNERS, lap_id="R")
    lap = make_lap(CORNERS, brake_shift_m=-20, min_speed_delta_kmh=-6, top_kmh=240)
    tmap = TrackMap(
        track_id="x",
        length_m=2000,
        corners=[
            Corner(id="a", name="A", start_m=1900, apex_m=1990, end_m=300),  # wraps
            Corner(id="b", name="B", start_m=301, apex_m=500, end_m=1250),  # 1 m after A
            Corner(id="c", name="C", start_m=1300, apex_m=1600, end_m=1800),
        ],
    )
    facts = lap_facts(tmap, lap, ref)
    total = sum(c.delta_s for c in facts.corners) + sum(s.delta_s for s in facts.straights)
    assert total == pytest.approx(float(lap.ch["t"][-1] - ref.ch["t"][-1]), abs=0.001)
