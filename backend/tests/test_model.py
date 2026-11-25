import numpy as np
import pytest

from racecoach.model import GRID_CHANNELS, LapKind, LapMeta, LapSource, LapTrace, lap_id_for
from tests.synthetic import SynthCorner, make_lap, make_raw_session

CORNERS = [SynthCorner(500, 90), SynthCorner(1200, 120, -1)]


def test_laptrace_rejects_mismatched_lengths():
    with pytest.raises(ValueError):
        LapTrace("x", np.arange(10.0), {"speed_kmh": np.zeros(9)})
    LapTrace("x", np.arange(10.0), {"speed_kmh": np.zeros(10)})


def _meta(valid: bool, override: bool | None) -> LapMeta:
    return LapMeta("a-001", "a", 1, LapKind.FLYING, 100.0, (), valid, override, False,
                   LapSource.OWN_RECORDING, "d", "t", "c")  # fmt: skip


def test_effective_valid_override():
    assert _meta(True, None).effective_valid is True
    assert _meta(False, None).effective_valid is False
    assert _meta(False, True).effective_valid is True
    assert _meta(True, False).effective_valid is False


def test_lap_id_format():
    assert lap_id_for("0123456789abcdef", 7) == "0123456789ab-007"


def test_make_lap_time_monotonic_and_min_speed_at_apex():
    lap = make_lap(CORNERS)
    assert set(GRID_CHANNELS) <= set(lap.ch)
    assert np.all(np.diff(lap.ch["t"]) > 0)
    for c in CORNERS:
        assert abs(lap.ch["speed_kmh"][int(c.apex_m)] - c.min_speed_kmh) <= 1.0
    assert lap.ch["g_lat"][500] == 1.5 and lap.ch["g_lat"][1200] == -1.5
    slower = make_lap(CORNERS, min_speed_delta_kmh=-5)
    assert abs(slower.ch["speed_kmh"][500] - 85) <= 1.0


def _onset(lap: LapTrace, apex: int) -> int:
    idx = np.nonzero(lap.ch["brake"][apex - 400 : apex] >= 0.1)[0]
    return apex - 400 + int(idx[0])


def test_brake_shift_moves_brake_onset():
    base = _onset(make_lap(CORNERS), 500)
    early = _onset(make_lap(CORNERS, brake_shift_m=-20), 500)
    assert abs((base - early) - 20) <= 1


def test_make_raw_session_structure():
    raw = make_raw_session(3, CORNERS, invalid_laps=(2,))
    assert [int(x) for x in raw.events["lap"].v] == [0, 1, 2, 3, 4]
    lt = raw.events["lap_time"].v
    assert len(lt) == 3 and lt[1] == 0.0 and lt[0] > 0
    assert list(raw.events["in_pits"].v) == [1, 0, 1]
    assert np.all(np.diff(raw.channels["lap_dist"].t) > 0)
    assert raw.channels["lap_dist"].v.max() <= 2000


def test_late_braking_stays_continuous():
    lap = make_lap(CORNERS, brake_shift_m=20)
    assert np.abs(np.diff(lap.ch["speed_kmh"])).max() < 5
