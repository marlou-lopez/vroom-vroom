import numpy as np

from racecoach.analysis.corners import detect_corners
from racecoach.model import LapTrace
from tests.synthetic import SynthCorner, make_lap


def test_detect_three_corners_on_synthetic():
    apexes = [500, 1100, 1600]
    lap = make_lap([SynthCorner(a, 90) for a in apexes], track_length_m=2000)
    found = detect_corners(lap)
    assert len(found) == 3
    for f, a in zip(found, apexes, strict=True):
        assert abs(f.apex_m - a) <= 5
        assert not f.flat
        assert f.start_m < f.apex_m < f.end_m
    assert found[0].end_m <= found[1].start_m


def _flat_lap() -> LapTrace:
    n = 2000
    s = np.arange(n, dtype=float)
    ch = {k: np.zeros(n) for k in ("speed_kmh", "g_lat", "brake", "throttle")}
    ch["speed_kmh"] = np.full(n, 200.0)
    ch["throttle"] = np.ones(n)
    ch["g_lat"][900:960] = 1.0
    ch["g_lat"][920:970] = 1.4  # peak zone
    return LapTrace("F", s, ch)


def test_flat_corner_detected():
    found = detect_corners(_flat_lap())
    assert len(found) == 1
    assert found[0].flat
    assert 920 <= found[0].apex_m < 970


def test_close_minima_merged():
    lap = make_lap([SynthCorner(1000, 90), SynthCorner(1040, 95)], track_length_m=2000)
    apart = make_lap([SynthCorner(1000, 90), SynthCorner(1200, 95)], track_length_m=2000)
    assert len(detect_corners(lap)) == 1
    assert len(detect_corners(apart)) == 2
