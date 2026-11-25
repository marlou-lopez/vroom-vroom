"""Under- and oversteer estimated from a recording (port of frontend/src/lib/carBalance.ts).

The path's yaw rate comes from lateral g. The yaw rate the steering asks for comes from a
per-car steady-state fit on the driver's own laps. The balance is the difference, signed by
the turn direction: > 0 understeer, < 0 oversteer, zero is the driver's usual balance.
Method and accuracy: docs/car-behaviour/oversteer-understeer.md.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass

import numpy as np

from racecoach.analysis.delta import corner_walk
from racecoach.model import LapTrace
from racecoach.tracks import Corner

G = 9.81
MIN_BALANCE_SPEED_MS = 15.0
SMOOTH_HALF_M = 4
MIN_TURN_DEG_S = 2.0
BALANCE_MARK_DEG_S = 5.0
OVERSTEER_MARK_DEG_S = 7.0
MARK_MIN_G = 0.5
MERGE_GAP_M = 3
MIN_RUN_M = 5
MIN_FIT_SAMPLES = 50


@dataclass(frozen=True)
class BalanceFit:
    a: float
    b: float
    c: float
    n: int


@dataclass(frozen=True)
class BalanceTrace:
    balance: np.ndarray  # NaN where not computed
    expected: np.ndarray
    actual: np.ndarray


Run = tuple[int, int]  # inclusive grid metres


def smooth(v: np.ndarray, half: int) -> np.ndarray:
    """Centred moving average that shrinks at the ends."""
    n = len(v)
    pre = np.concatenate([[0.0], np.cumsum(v, dtype=float)])
    i = np.arange(n)
    lo = np.maximum(0, i - half)
    hi = np.minimum(n - 1, i + half)
    return (pre[hi + 1] - pre[lo]) / (hi - lo + 1)


def _prepare(lap: LapTrace, range_deg: float):
    g_lat = smooth(np.asarray(lap.ch["g_lat"], dtype=float), SMOOTH_HALF_M)
    steer = smooth(np.asarray(lap.ch["steering"], dtype=float), SMOOTH_HALF_M)
    v = np.asarray(lap.ch["speed_kmh"], dtype=float) / 3.6
    with np.errstate(divide="ignore", invalid="ignore"):
        kappa = np.where(v > 0, G * g_lat / (v * v), 0.0)
    theta = -steer * range_deg / 2  # steering + is right; the fit is left-positive
    return v, kappa, theta, g_lat


def fit_balance(laps: Sequence[LapTrace], range_deg: float) -> BalanceFit | None:
    """Least squares of [kappa, kappa*v^2, 1] on theta over every metre at speed, no wheel off."""
    xs: list[np.ndarray] = []
    ys: list[np.ndarray] = []
    for lap in laps:
        v, kappa, theta, _ = _prepare(lap, range_deg)
        ok = v >= MIN_BALANCE_SPEED_MS
        if "wheels_off" in lap.ch:
            ok &= np.asarray(lap.ch["wheels_off"], dtype=float) <= 0
        xs.append(np.column_stack([kappa, kappa * v * v, np.ones_like(v)])[ok])
        ys.append(theta[ok])
    x = np.concatenate(xs)
    y = np.concatenate(ys)
    if len(y) < MIN_FIT_SAMPLES:
        return None
    try:
        sol = np.linalg.solve(x.T @ x, x.T @ y)
    except np.linalg.LinAlgError:
        return None
    if not np.all(np.isfinite(sol)):
        return None
    return BalanceFit(float(sol[0]), float(sol[1]), float(sol[2]), len(y))


def balance_trace(lap: LapTrace, range_deg: float, fit: BalanceFit) -> BalanceTrace:
    v, kappa, theta, _ = _prepare(lap, range_deg)
    gain = fit.a + fit.b * v * v
    valid = (v >= MIN_BALANCE_SPEED_MS) & (gain > 0)
    deg = 180 / np.pi
    with np.errstate(divide="ignore", invalid="ignore"):
        r_exp = v * (theta - fit.c) / gain * deg
    r_act = v * kappa * deg
    sign = np.where(np.abs(r_act) > MIN_TURN_DEG_S, np.sign(r_act), np.sign(r_exp))
    balance = sign * (r_exp - r_act)
    nan = np.full(len(v), np.nan)
    return BalanceTrace(
        np.where(valid, balance, nan), np.where(valid, r_exp, nan), np.where(valid, r_act, nan)
    )


def runs_of(pred: np.ndarray, merge_gap: int) -> list[Run]:
    """Runs of True, merging runs whose gap is at most `merge_gap` metres."""
    idx = np.flatnonzero(pred)
    runs: list[list[int]] = []
    for i in idx:
        if runs and i - runs[-1][1] - 1 <= merge_gap:
            runs[-1][1] = int(i)
        else:
            runs.append([int(i), int(i)])
    return [(a, b) for a, b in runs]


def balance_runs(lap: LapTrace, trace: BalanceTrace) -> tuple[list[Run], list[Run]]:
    """(understeer runs, oversteer runs): past the marks, in a corner, at least MIN_RUN_M long."""
    g_lat = np.abs(smooth(np.asarray(lap.ch["g_lat"], dtype=float), SMOOTH_HALF_M))
    with np.errstate(invalid="ignore"):
        counter = (np.sign(trace.expected) != np.sign(trace.actual)) & (
            np.abs(trace.actual) > MIN_TURN_DEG_S
        )
        under = (trace.balance > BALANCE_MARK_DEG_S) & (g_lat >= MARK_MIN_G)
        over = (trace.balance < -OVERSTEER_MARK_DEG_S) & ((g_lat >= MARK_MIN_G) | counter)

    def keep(runs: list[Run]) -> list[Run]:
        return [r for r in runs if r[1] - r[0] + 1 >= MIN_RUN_M]

    return keep(runs_of(under, MERGE_GAP_M)), keep(runs_of(over, MERGE_GAP_M))


@dataclass(frozen=True)
class LapBalance:
    balance: np.ndarray  # NaN where not computed
    understeer_runs: list[Run]
    oversteer_runs: list[Run]  # experimental, never given to the coach

    def for_api(self) -> list[float | None]:
        """One decimal, None where not computed."""
        return [None if not np.isfinite(b) else round(float(b), 1) for b in self.balance]


def compare_balance(
    lap: LapTrace,
    ref: LapTrace,
    lap_range_deg: float | None,
    ref_range_deg: float | None,
    same_car: bool,
    fit_laps: Sequence[LapTrace] | None = None,
) -> tuple[LapBalance | None, LapBalance | None]:
    """Balance of a lap and its reference. One fit is made on `fit_laps` (all the driver's laps
    in this car; the issue asks for that calibration) when given and the car's steering range
    is the same, else on both laps, else one per lap."""

    def one(trace: LapTrace, rng: float | None, fit: BalanceFit | None) -> LapBalance | None:
        if rng is None or fit is None:
            return None
        t = balance_trace(trace, rng, fit)
        under, over = balance_runs(trace, t)
        return LapBalance(t.balance, under, over)

    if same_car and lap_range_deg is not None and lap_range_deg == ref_range_deg:
        fit = fit_balance(list(fit_laps) if fit_laps else [lap, ref], lap_range_deg)
        return one(lap, lap_range_deg, fit), one(ref, ref_range_deg, fit)
    lap_fit = None if lap_range_deg is None else fit_balance([lap], lap_range_deg)
    ref_fit = None if ref_range_deg is None else fit_balance([ref], ref_range_deg)
    return one(lap, lap_range_deg, lap_fit), one(ref, ref_range_deg, ref_fit)


def corner_understeer(balance: np.ndarray | None, corner: Corner) -> tuple[float, float] | None:
    """(peak, mean) understeer of a corner in deg/s: peak is the largest balance floored at 0,
    mean is over the metres past the understeer mark (0 when none). None without any balance."""
    if balance is None or len(balance) == 0:
        return None
    vals = balance[corner_walk(corner, len(balance)).idx]
    vals = vals[np.isfinite(vals)]
    if len(vals) == 0:
        return None
    marked = vals[vals > BALANCE_MARK_DEG_S]
    mean = round(float(marked.mean()), 1) if len(marked) else 0.0
    return round(max(0.0, float(vals.max())), 1), mean

