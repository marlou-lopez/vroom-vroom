"""Confidence test for traced edges: a line far from a well-supported recorded width, or where the recorded width is only
interpolated over a long gap, is not trusted (written as unseen). Pure numpy, unit-tested in test_confidence.py."""
from __future__ import annotations

import numpy as np

SUPPORT_M = 15.0  # a recorded width within this many metres is "well supported"
NEAR_TOL_M = 4.0  # supported: the line may differ from the recorded width by this much (after removing the constant width bias). Loose on purpose: on Spa the recorded width is itself 1-3 m off the painted line for 250 m, where the survey agrees with the line
FAR_TOL_M = 1.5  # not supported: the recorded width is only interpolated (a guess, metres off on Monza), so the
#                  line is judged against its own surroundings: the median of the seen line over +-WINDOW_M
WINDOW_M = 150
RAMP = 0.7  # a wrong line ramps in and out: a rejected run reaches as far as the line is still half the limit off
GROW_M = 2  # and the metres around it go too
MIN_SEEN_M = 6  # seen stretches shorter than this are dropped (a lone good-looking patch is not a line)


def gap_distance(raw: np.ndarray) -> np.ndarray:
    """Metres (samples) from each point to the nearest recorded width, around the closed loop."""
    n = len(raw)
    ok = np.flatnonzero(np.isfinite(raw))
    if not len(ok):
        return np.full(n, np.inf)
    i = np.arange(n)
    pos = np.searchsorted(ok, i)
    a, b = ok[(pos - 1) % len(ok)], ok[pos % len(ok)]
    return np.minimum((i - a) % n, (b - i) % n).astype(float)


def drop_short(seen: np.ndarray, min_len: int = MIN_SEEN_M) -> np.ndarray:
    """Remove seen runs shorter than min_len (closed loop)."""
    n = len(seen)
    out = seen.copy()
    if seen.all() or not seen.any():
        return out
    start = int(np.flatnonzero(~seen)[0])
    rolled = np.roll(seen, -start)
    i = 0
    while i < n:
        if rolled[i]:
            j = i
            while j < n and rolled[j]:
                j += 1
            if j - i < min_len:
                rolled[i:j] = False
            i = j
        else:
            i += 1
    return np.roll(rolled, start)


def running_median(edge: np.ndarray, seen: np.ndarray, window: int = WINDOW_M) -> np.ndarray:
    """Median of the seen edge within +-window metres (closed loop); NaN where fewer than window/3 metres were seen."""
    n = len(edge)
    out = np.full(n, np.nan)
    for i in range(n):
        idx = np.arange(i - window, i + window + 1) % n
        v = edge[idx][seen[idx]]
        if len(v) >= window / 3:
            out[i] = np.median(v)
    return out


def hysteresis(seed: np.ndarray, weak: np.ndarray) -> np.ndarray:
    """The runs of `weak` that contain at least one `seed` sample (closed loop)."""
    from scipy.ndimage import label
    n = len(seed)
    lab, k = label(np.r_[weak, weak, weak])
    keep = np.unique(lab[np.r_[seed, seed, seed]])
    keep = keep[keep > 0]
    out = np.isin(lab, keep)
    return out[:n] | out[n:2 * n] | out[2 * n:]


def grow(mask: np.ndarray, m: int) -> np.ndarray:
    n = len(mask)
    out = mask.copy()
    for k in range(1, m + 1):
        out |= np.roll(mask, k) | np.roll(mask, -k)
    return out if n else out


def trusted(edge: np.ndarray, seen: np.ndarray, raw: np.ndarray, prior: np.ndarray, *, support_m=SUPPORT_M, near_tol=NEAR_TOL_M,
            far_tol=FAR_TOL_M, window=WINDOW_M, grow_m=GROW_M, min_seen=MIN_SEEN_M, ramp=RAMP) -> np.ndarray:
    """`seen` with the lines that fail the test cleared. edge/prior: half-width per metre (the traced line and the recorded
    width filled over gaps); raw: recorded half-width, NaN where no lap used this side.
    Near a recorded width (well supported) the line must stay within near_tol of it, bar a constant bias. Further away the
    filled width is a guess and proves nothing, so the line must stay within far_tol of its own running median."""
    dist = gap_distance(raw)
    near = dist <= support_m
    sup = seen & near
    bias = float(np.median((edge - prior)[sup])) if sup.any() else 0.0
    med = running_median(edge, seen, window)
    dev = np.where(near, np.abs(edge - prior - bias) / near_tol, np.abs(edge - med) / far_tol)  # 1 = at the limit
    bad = seen & hysteresis(dev > 1.0, dev > ramp)
    return drop_short(seen & ~grow(bad, grow_m), min_seen)
