"""Edges and kerbs from the straightened image: row = along the lap, column = metres left of the centreline."""
from __future__ import annotations

import numpy as np
from scipy.ndimage import gaussian_filter1d, uniform_filter1d

DL = 0.1  # lateral step, m
DS = 0.25  # along-track step of the kerb strip, m
REACH = 18.0  # half width of the strip, m
LINE_HALF_M = 0.1  # half a painted edge line; the edge is its outer side, where LMU's tarmac ends
PRIOR_SIGMA_M = 3.0  # trust in LMU's recorded half-width (it is off by 0.2 m at the median, 0.8 m at p90)
MAX_STEP = 4  # lateral steps of DL per metre the edge may move
MIN_SCORE = 14.0  # grey levels of line against the asphalt beside it


def line_score(strip: np.ndarray) -> np.ndarray:
    """How much each pixel looks like a painted line with asphalt on its inner side; the strip runs from the centre outwards."""
    white = gaussian_filter1d(strip.min(2), 1.0, axis=1)
    k = lambda a, b: (int(a / DL), int(b / DL))
    cs = np.cumsum(np.pad(white, ((0, 0), (1, 0))), axis=1)
    c2 = np.cumsum(np.pad(white**2, ((0, 0), (1, 0))), axis=1)
    a, b = k(0.5, 2.0)
    n = white.shape[1]
    i = np.arange(n)
    lo, hi = np.clip(i - b, 0, n), np.clip(i - a, 1, n)
    cnt = np.maximum(hi - lo, 1)
    mean = (cs[:, hi] - cs[:, lo]) / cnt
    std = np.sqrt(np.maximum((c2[:, hi] - c2[:, lo]) / cnt - mean**2, 0))
    peak = white - np.maximum(np.roll(white, 3, 1), 0)
    return np.where(i > b, np.clip(np.minimum(white - mean, peak * 2 + 10), 0, 60) - 0.8 * std, -20)


def trace(score: np.ndarray, prior: np.ndarray) -> np.ndarray:
    """The smooth path through the scores near the prior half-width (dynamic programming, one row per metre)."""
    n, m = score.shape
    lat = np.arange(m) * DL
    cost = -gaussian_filter1d(score, 1.5, axis=0) + 10 * ((lat[None] - prior[:, None]) / PRIOR_SIGMA_M) ** 2
    cost = np.vstack([cost[-60:], cost, cost[:60]])
    acc, back = cost[0].copy(), np.zeros(cost.shape, np.int8)
    for r in range(1, len(cost)):
        best = np.full(m, np.inf)
        for s in range(-MAX_STEP, MAX_STEP + 1):
            v = np.full(m, np.inf)
            src = slice(max(0, -s), m - max(0, s))
            v[max(0, s):m - max(0, -s)] = acc[src] + 3.0 * s * s
            take = v < best
            best[take] = v[take]
            back[r][take] = s
        acc = best + cost[r]
    path = np.empty(len(cost), int)
    path[-1] = int(np.argmin(acc))
    for r in range(len(cost) - 1, 0, -1):
        path[r - 1] = path[r] - back[r][path[r]]
    return path[60:-60]


def find_edge(strip: np.ndarray, prior: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Edge half-width per metre and whether a line was seen there. strip: (metres, lateral from 0 outwards, RGB)."""
    s = line_score(strip)
    p = trace(s, prior)
    n = len(p)
    sm = gaussian_filter1d(s, 1.0, axis=0)
    # sub-step: parabola through the score's peak
    i = np.clip(p, 1, s.shape[1] - 2)
    a, b, c = (sm[np.arange(n), i + d] for d in (-1, 0, 1))
    den = a - 2 * b + c
    off = np.where(den < -1e-6, 0.5 * (a - c) / np.where(den == 0, 1, den), 0).clip(-0.5, 0.5)
    seen = uniform_filter1d(sm[np.arange(n), p], 5, mode="wrap") > MIN_SCORE
    return gaussian_filter1d((i + off) * DL, 1.0, mode="wrap") + LINE_HALF_M, seen


STRIPE_PERIOD_M = (0.8, 8.0)
WIN_M = 12.0


def stripe_signal(band: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Per DS step of a band beside the edge (steps, lateral, RGB): stripe amplitude, how periodic it is (0..1), how coloured it is."""
    c = band.mean(1)
    rg = c[:, 0] - c[:, 1]  # red against yellow, white or green
    w = int(WIN_M / DS)
    lo = gaussian_filter1d(rg, STRIPE_PERIOD_M[1] / DS / 2, mode="wrap")
    x = gaussian_filter1d(rg, 0.2 / DS, mode="wrap") - lo
    var = uniform_filter1d(x * x, w // 2, mode="wrap")
    lags = np.arange(int(STRIPE_PERIOD_M[0] / DS), int(STRIPE_PERIOD_M[1] / DS) + 1)
    best = np.full(len(x), -1.0)
    neg = np.zeros(len(x))
    for L in lags:
        r = uniform_filter1d(x * np.roll(x, -L), w, mode="wrap", origin=0)
        r = np.roll(r, L // 2) / (uniform_filter1d(x * x, w + L, mode="wrap") + 1)
        neg = np.minimum(neg, r)
        ok = neg < -0.2  # a real period swings through anti-phase first; a lone patch does not
        best = np.where(ok & (r > best), r, best)
    col = uniform_filter1d(c.max(1) - c.min(1), w // 4, mode="wrap")
    return np.sqrt(var), np.clip(best, 0, 1), col


MIN_AMP, MIN_PERIODIC, MIN_COLOUR = 6.0, 0.2, 15.0
GAP_M = 4.0  # pieces of one kerb, split by a white or dirty stripe
PAINT_CHROMA, PAINT_MIN_M = 30.0, 8.0


def spans(mask: np.ndarray, gap_m: float) -> list[list[int]]:
    out: list[list[int]] = []
    for i in np.flatnonzero(mask):
        if out and i - out[-1][1] <= gap_m / DS:
            out[-1][1] = int(i)
        else:
            out.append([int(i), int(i)])
    return out


def beside(strip: np.ndarray, edge: np.ndarray) -> np.ndarray:
    """The band of image just outside the edge (steps, lateral, RGB)."""
    cols = np.clip(np.round((edge[:, None] + np.arange(0.15, 0.85, DL)) / DL).astype(int), 0, strip.shape[1] - 1)
    return strip[np.arange(len(strip))[:, None], cols]


def kerb_runs(strip: np.ndarray, edge: np.ndarray, side: str, min_len=4.0) -> tuple[list[dict], list[dict]]:
    """Kerb runs and solid painted run-off beside an edge. strip: (DS steps, lateral from 0 outwards, RGB); edge: half-width
    per DS step. The stripe-period test (12 m window) finds the kerb; its ends come from where the warm colour (red, yellow)
    starts and stops, which is sharper than that window."""
    n = len(strip)
    band = beside(strip, edge)
    amp, per, col = stripe_signal(band)
    strong = (amp > MIN_AMP) & (per > MIN_PERIODIC) & (col > MIN_COLOUR)
    c = gaussian_filter1d(band.mean(1), 0.2 / DS, axis=0, mode="wrap")
    warm = c[:, 0] - c[:, 2]
    taken = np.zeros(n, bool)
    cores = []
    for a, z in spans(strong, GAP_M):
        if (z - a) * DS < 2:
            continue
        level = max(8.0, 0.4 * np.percentile(warm[a:z + 1], 75))
        lo, hi = max(0, a - int(8 / DS)), min(n, z + 1 + int(8 / DS))
        near = [[x + lo, y + lo] for x, y in spans(warm[lo:hi] > level, GAP_M)]
        near = [s for s in near if s[0] <= z and s[1] >= a]  # overlaps the striped core
        if near:
            cores.append([near[0][0], near[-1][1]])
    joined: list[list[int]] = []
    for s in sorted(cores):
        if joined and s[0] - joined[-1][1] <= GAP_M / DS:
            joined[-1][1] = max(joined[-1][1], s[1])
        else:
            joined.append(s)
    out = []
    for a, z in joined:
        if (z - a) * DS >= min_len:
            taken[a:z + 1] = True
            out.append({"side": side, "start": a * DS, "end": z * DS, "width": kerb_width(strip[a:z + 1], edge[a:z + 1])})
    grass = (c[:, 1] > c[:, 0]) & (c.mean(1) < 110)
    solid = (c.max(1) - c.min(1) > PAINT_CHROMA) & ~taken & ~grass
    painted = [{"side": side, "start": a * DS, "end": z * DS} for a, z in spans(solid, 1.0) if (z - a) * DS >= PAINT_MIN_M]
    return out, painted


def kerb_width(strip: np.ndarray, edge: np.ndarray) -> float:
    """How far out the stripes go: along-track swing of red-green per lateral step, until it halves."""
    off = np.arange(0.2, 3.0, DL)
    cols = np.clip(np.round((edge[:, None] + off) / DL).astype(int), 0, strip.shape[1] - 1)
    b = strip[np.arange(len(strip))[:, None], cols]
    rg = b[..., 0] - b[..., 1]
    hp = rg - gaussian_filter1d(rg, 3 / DS, axis=0)
    sw = hp.std(0)
    top = np.median(sw[:5])
    below = np.flatnonzero(sw < top / 2)
    return round(float(off[below[0]] if len(below) else off[-1]), 2)
