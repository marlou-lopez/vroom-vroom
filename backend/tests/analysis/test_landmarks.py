import re
from typing import Literal

import numpy as np

from racecoach.analysis.landmarks import (
    describe_position,
    detect_kerbs,
    own_lap_cue,
    usable_landmarks,
)
from racecoach.model import LapTrace
from racecoach.tracks import Corner, Landmark, TrackMap
from tests.synthetic import SynthCorner, make_lap

TMAP = TrackMap(
    track_id="x",
    length_m=2000,
    corners=[Corner(id="t1", name="T1", start_m=400, apex_m=500, end_m=650)],
)


def _lap(kerbs: list[tuple[int, int]], lap_id: str = "L") -> LapTrace:
    lap = make_lap([SynthCorner(500, 90)], track_length_m=2000, lap_id=lap_id)
    kerb = np.zeros(2000)
    for a, b in kerbs:
        kerb[a:b] = 1
    lap.ch["kerb"] = kerb
    return lap


def test_classifies_entry_apex_exit():
    laps = [_lap([(440, 450), (495, 505), (580, 590)]) for _ in range(4)]
    found = {lm.kind: lm for lm in detect_kerbs(laps, TMAP)}
    assert set(found) == {"kerb_entry", "kerb_apex", "kerb_exit"}
    assert abs(found["kerb_entry"].distance_m - 445) <= 2
    assert found["kerb_apex"].label == "T1 apex kerb"
    assert all(lm.confidence == "detected" and lm.corner_id == "t1" for lm in found.values())


def test_requires_half_of_laps():
    laps = [_lap([(495, 505)]), _lap([(495, 505)]), _lap([]), _lap([])]
    assert len(detect_kerbs(laps, TMAP)) == 1  # 2 of 4 is enough
    assert detect_kerbs(laps[:1] + laps[2:], TMAP) == []  # 1 of 3 is not


def test_clusters_within_10m_and_ignores_outside_corners():
    laps = [_lap([(495 + 3 * i, 500 + 3 * i), (1200, 1210)]) for i in range(4)]
    found = detect_kerbs(laps, TMAP)
    assert len(found) == 1  # the kerb at 1200 is in no corner


def test_edge_filter_drops_type5_hits_away_from_edge():
    laps = []
    for _ in range(3):
        lap = _lap([(495, 505)])
        lap.ch["path_lateral"] = np.full(2000, 0.5)  # nowhere near the 6 m edge
        laps.append(lap)
    assert detect_kerbs(laps, TMAP) == []
    for lap in laps:
        lap.ch["path_lateral"][490:510] = 5.0
    assert len(detect_kerbs(laps, TMAP)) == 1


def test_suspension_peak_counts_at_edge():
    laps = []
    for _ in range(3):
        lap = _lap([])
        lap.ch["path_lateral"] = np.full(2000, 5.5)
        lap.ch["susp_fl"] = np.where((np.arange(2000) // 2) % 2 == 0, 0.0, 0.05)[:2000] * (
            (np.arange(2000) >= 495) & (np.arange(2000) < 505)
        )
        laps.append(lap)
    assert len(detect_kerbs(laps, TMAP)) == 1


def _lm(
    label: str = "T1 apex kerb",
    d: float = 500.0,
    conf: Literal["low", "detected", "confirmed"] = "detected",
) -> Landmark:
    return Landmark(id=label, label=label, kind="kerb_apex", distance_m=d, confidence=conf)


def test_describe_position_thresholds():
    lms = [_lm()]
    assert describe_position(500, lms) == "at the T1 apex kerb"
    assert describe_position(508, lms) == "at the T1 apex kerb"
    assert describe_position(470, lms) == "just before the T1 apex kerb"
    assert describe_position(520, lms) == "shortly after the T1 apex kerb"
    assert describe_position(540, lms) == "shortly after the T1 apex kerb"
    assert describe_position(541, lms) is None
    assert describe_position(459, lms) is None


def test_describe_position_never_low_confidence_and_no_metres():
    assert describe_position(500, [_lm(conf="low")]) is None
    assert describe_position(500, [_lm(label="100m board")]) is None
    assert usable_landmarks([_lm(conf="confirmed"), _lm(conf="low")]) == [_lm(conf="confirmed")]
    for pos in range(0, 2000, 7):
        out = describe_position(pos, [_lm(), _lm("T2 exit kerb", 700)])
        assert out is None or not re.search(r"\d\s*m\b", out)


def test_describe_position_wraps_start_line():
    lm = _lm("start kerb", 1990)
    assert describe_position(5, [lm]) is None
    assert describe_position(5, [lm], length_m=2000) == "shortly after the start kerb"


def test_own_lap_cue():
    lap7 = _lap([])
    lap7.ch["brake"] = np.zeros(2000)
    lap7.ch["brake"][300:340] = 1.0
    lap8 = _lap([])
    lap8.ch["brake"] = np.zeros(2000)
    lap8.ch["brake"][310:350] = 1.0
    assert own_lap_cue(301, [(7, lap7), (8, lap8)]) == "where you braked on lap 7"
    assert own_lap_cue(312, [(7, lap7), (8, lap8)]) == "where you braked on lap 8"
    assert own_lap_cue(304, [(7, lap7)]) is None  # 4 m away
    assert own_lap_cue(303, [(7, lap7)]) == "where you braked on lap 7"
