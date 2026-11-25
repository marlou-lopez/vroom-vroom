import numpy as np

import confidence as c


def test_gap_distance_wraps():
    raw = np.full(100, np.nan)
    raw[[10, 90]] = 5.0
    d = c.gap_distance(raw)
    assert d[10] == 0 and d[0] == 10 and d[50] == 40 and d[99] == 9


def test_far_line_near_support_is_rejected():
    n = 200
    raw = np.full(n, 6.0)
    edge = raw.copy()
    edge[80:100] += 5.0  # cuts across the escape road
    seen = np.ones(n, bool)
    out = c.trusted(edge, seen, raw, raw)
    assert not out[80:100].any() and out[:70].all() and out[110:].all()


def test_constant_bias_is_not_a_fault():
    n = 200
    raw = np.full(n, 6.0)
    out = c.trusted(raw + 0.2, np.ones(n, bool), raw, raw)
    assert out.all()


def test_unsupported_line_judged_against_its_own_surroundings():
    n = 600
    raw = np.full(n, np.nan)
    raw[:20] = 6.0
    prior = np.full(n, 4.0)  # a bad guess: the line at 6 m is right and must stay
    edge = np.full(n, 6.0)
    edge[300:360] -= 3.0  # cuts across the escape road, nowhere near a recording
    out = c.trusted(edge, np.ones(n, bool), raw, prior)
    assert not out[300:360].any() and out[100:280].all() and out[400:580].all()


def test_gradual_width_change_is_kept():
    n = 600
    raw = np.full(n, np.nan)
    edge = 6.0 + np.linspace(0, 0.8, n)
    out = c.trusted(edge, np.ones(n, bool), raw, np.full(n, 4.0))
    assert out.all()


def test_rejection_grows_into_the_ramps():
    n = 600
    raw = np.full(n, np.nan)
    edge = np.full(n, 6.0)
    edge[300:310] = 3.0
    out = c.trusted(edge, np.ones(n, bool), raw, edge)
    assert not out[298:312].any() and out[:280].all()


def test_short_seen_islands_dropped():
    seen = np.zeros(100, bool)
    seen[10:14] = True
    seen[30:60] = True
    out = c.drop_short(seen, 6)
    assert not out[10:14].any() and out[30:60].all()
