import numpy as np

from racecoach.telemetry.distance import fuse_distance, lap_distance_samples


def _truth(rng_seed: int = 1):
    rng = np.random.default_rng(rng_seed)
    t = np.arange(0, 120, 0.01)
    v = 50 + 25 * np.sin(t / 7) + 10 * np.sin(t / 2.3)  # m/s
    d = np.concatenate([[0], np.cumsum((v[1:] + v[:-1]) / 2 * 0.01)])
    return rng, t, v, d


def test_fuse_distance_rms_under_2m():
    rng, t, v, d = _truth()
    noisy = v + rng.normal(0, 0.5 / 3.6, len(v))  # speed noise sigma 0.5 km/h
    t_ld = np.arange(0, 120, 0.1)  # 10 Hz, quantised to 0.5 m
    ld = np.round(np.interp(t_ld, t, d) * 2) / 2
    fused = fuse_distance(t, noisy, t_ld, ld, track_length_m=float(d[-1]) + 10)
    assert np.sqrt(np.mean((fused - d) ** 2)) < 2.0
    assert np.all(np.diff(fused) >= 0)


def test_fuse_distance_corrects_a_scale_error_and_is_clipped():
    _, t, v, d = _truth()
    t_ld = np.arange(0, 120, 0.1)
    ld = np.interp(t_ld, t, d)
    fused = fuse_distance(t, v * 1.03, t_ld, ld, track_length_m=float(d[-1]) - 100)
    assert fused.max() == d[-1] - 100
    assert np.abs(fused[: len(fused) // 2] - d[: len(fused) // 2]).max() < 1.0


def test_fuse_distance_through_origin_starts_at_zero():
    _, t, v, d = _truth()
    t_ld = np.arange(0, 120, 0.1)
    fused = fuse_distance(t, v, t_ld, np.interp(t_ld, t, d), 1e6, through_origin=True)
    assert fused[0] == 0 and np.abs(fused - d).max() < 0.5


def test_lap_distance_samples_drops_the_line_wrap_at_both_ends():
    L = 1000.0
    t = np.arange(10.0, 20.0, 0.5)
    d = np.linspace(0, L, len(t), endpoint=False)
    d[:2] = [999.5, 999.8]  # still the previous lap's end
    d[-2:] = [0.5, 1.0]  # already the next lap's start
    t2, d2, cut = lap_distance_samples(t, d, L, t_start=10.0, t_end=20.0)
    assert cut is None and len(d2) == len(d) - 4 and np.all(np.diff(d2) > 0) and d2.max() < L


def test_lap_distance_samples_keeps_only_what_follows_a_mid_lap_crossing():
    L = 1000.0
    t = np.arange(0.0, 10.0, 0.5)
    d = (900 + np.arange(len(t)) * 20.0) % L  # crosses the line at t = 2.5
    t2, d2, cut = lap_distance_samples(t, d, L, t_start=-100.0, t_end=100.0)
    assert cut is not None and cut == t2[0] == 2.5 and d2[0] == 0 and np.all(np.diff(d2) > 0)


def test_fuse_distance_follows_lap_dist_through_a_speed_drift():
    _, t, v, d = _truth()
    t_ld = np.arange(0, 120, 0.02)
    ld = np.round(np.interp(t_ld, t, d) * 2) / 2
    drift = 1 + 0.03 * np.sin(t / 15)  # a speed error one scale factor cannot absorb
    fused = fuse_distance(t, v * drift, t_ld, ld, 1e6)
    assert np.abs(fused - d).max() < 1.5
