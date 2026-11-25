import numpy as np

from racecoach.model import GRID_CHANNELS, Channel
from racecoach.telemetry.resample import any_on, to_distance_grid


def _clock(n_s: float = 20.0, v: float = 50.0):
    t = np.arange(0.0, n_s, 0.01)
    return t, v * t  # constant speed: distance = 50 m/s * t


def test_resample_linear_channel_exact():
    t, d = _clock()
    grid = to_distance_grid("L", d, t, {"speed_kmh": Channel(t, d)}, length_m=d[-1])
    assert np.allclose(grid.ch["speed_kmh"], grid.distance, atol=1e-9)
    assert np.allclose(grid.ch["t"], grid.distance / 50, atol=1e-9)
    assert set(GRID_CHANNELS) <= set(grid.ch)
    assert grid.distance[0] == 0 and np.all(np.diff(grid.distance) == 1)


def test_resample_gear_is_stepwise():
    t, d = _clock()
    gear = Channel(np.array([0.0, 4.0, 9.5]), np.array([2.0, 3.0, 4.0]))
    g = to_distance_grid("L", d, t, {"gear": gear}, length_m=d[-1]).ch["gear"]
    assert set(np.unique(g)) == {2.0, 3.0, 4.0}
    assert g[199] == 2 and g[200] == 3 and g[474] == 3 and g[475] == 4  # 50 m/s


def test_abs_is_on_if_any_pulse_falls_in_the_metre_and_carries_its_state():
    t, d = _clock()
    # a 15 ms pulse inside metre 100 (t = 2.0 .. 2.02) and a state that stays on from 5.0 to 5.1
    ev = Channel(np.array([2.005, 2.02, 5.0, 5.1]), np.array([1.0, 0.0, 1.0, 0.0]))
    a = to_distance_grid("L", d, t, {"abs": ev}, length_m=d[-1]).ch["abs"]
    assert a[100] == 1 and a[99] == 0 and a[101] == 0
    assert a[250:256].tolist() == [1, 1, 1, 1, 1, 0]  # on from t=5.0 (metre 250) for 5 metres


def test_any_on_carries_state_into_a_window_without_samples():
    ch = Channel(np.array([0.0, 1.0]), np.array([1.0, 0.0]))
    assert any_on(ch, np.array([0.5]), np.array([0.6])).tolist() == [1.0]
    assert any_on(ch, np.array([1.5]), np.array([1.6])).tolist() == [0.0]


def test_yaw_rate_is_derived_from_g_lat_and_speed():
    t, d = _clock()
    chs = {
        "g_lat": Channel(t, np.full(len(t), 1.0)),
        "speed_kmh": Channel(t, np.full(len(t), 180.0)),
    }
    yaw = to_distance_grid("L", d, t, chs, length_m=d[-1]).ch["yaw_rate"]
    assert np.allclose(yaw, 9.81 / 50)


def test_slip_defaults_to_one_and_grid_stops_at_the_last_distance():
    t, d = _clock()
    grid = to_distance_grid("L", d, t, {}, length_m=1e9)
    assert np.all(grid.ch["slip_fl"] == 1) and grid.distance[-1] == np.floor(d[-1])
