"""The session report's fixed rules: events over a whole session (port of
`frontend/src/lib/sessionReport.ts`, vroom-bi4.11, tolerances and noise filters of vroom-bi4.13).

Events are found by fixed rules, judged against the session itself and the working windows in
`report_windows.py`. A cause is only ever stated as co-occurrence ("coincides with"), never as
"because"; there is no tyre load, grip or setup advice. The wording is templated: every number a
sentence uses is in the event's `numbers`.

Categories whose input the backend does not store are listed in `unavailable`, never reported as an
empty pass: `settings` (the recording's in-car setting events are not kept) and, per session, those
that need stint stats or 1 m traces.
"""

from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal
from typing import Any

import numpy as np

from racecoach.model import LapKind, LapTrace
from racecoach.report_windows import ClassWindows, Range, Window, window_list, windows_for
from racecoach.stint import SLOW_LAP_FACTOR, Stint, StintLap, Wheels
from racecoach.tracks import Corner

CATEGORIES = ("tyres", "brakes", "driving", "settings", "pace", "conditions")
AXLES = ("front", "rear")

RULES = {
    # Laps a tyre value must be outside its window before it is an event.
    "tyre_min_laps": 2,
    "brake_temp_min_laps": 1,
    "brake_ratio_min_laps": 2,
    # Smallest time a coincidence must show to be reported (s).
    "min_lost_s": 0.05,
    "min_corner_lost_s": 0.03,
    "lockup_min_laps": 2,
    "wheelspin_min_laps": 2,
    # Lock-up and wheelspin trend per corner (vroom-bij).
    "corner_trend_min_laps": 6,
    "corner_trend_min_count": 3,
    "corner_trend_min_change": 2,
    "abs_corner_min_m": 15,
    "tc_corner_min_m": 10,
    "max_aid_corners": 3,
    # Aid trend: change across the session as a share of the first lap's value, and in metres.
    "trend_share": 0.2,
    "trend_min_m": 30,
    "trend_min_laps": 6,
    # An ABS or TC activation says nothing by itself (vroom-bi4.13).
    "aid_best_diff_m": 8,
    "aid_best_diff_share": 0.3,
    "falloff_min": 0.05,
    "falloff_watch": 0.1,
    "falloff_problem": 0.3,
    "track_temp_drift_c": 2,
    "pit_cooling_share": 0.2,
    # 'Vs your best laps'
    "best_share": 0.2,
    "best_min_set": 3,
    "best_min_others": 2,
    "best_temp_diff_c": 5,
    "best_pressure_diff_kpa": 5,
    "best_brake_diff_c": 40,
    "best_min_laps": 2,
}  # fmt: skip

UNAVAILABLE_STATS = "This session has no stint stats (tyre, brake, fuel and track temperatures)."
UNAVAILABLE_SETTINGS = "The recording's in-car setting events are not stored by the backend."
UNAVAILABLE_TRACES = "No 1 m traces with driver-aid channels in this session."

Run = tuple[int, int]
AidRuns = dict[str, list[Run]]  # abs, tc, lockup, wheelspin


@dataclass
class ReportLapInput:
    lap_id: str
    lap_no: int
    kind: str
    lap_time_s: float | None
    valid: bool
    has_trace: bool


@dataclass
class TraceFacts:
    """What a lap's 1 m trace gives the report: the aid runs and each corner's time."""

    aids: AidRuns | None
    corner_times_s: list[float]


@dataclass
class ReportInput:
    session_id: str
    car_class: str
    laps: list[ReportLapInput]
    stats: list[StintLap] | None
    stints: list[Stint]
    corners: list[Corner]
    traces: dict[int, TraceFacts] = field(default_factory=dict)
    aid_activation: dict[int, dict[str, float]] = field(default_factory=dict)


# ---- JavaScript-compatible number helpers, so the sentences match the frontend's ----


def r(v: float, d: int = 2) -> float:
    """Math.round(v * 10^d) / 10^d: JavaScript rounds halves up, Python's round() to even."""
    return math.floor(v * 10**d + 0.5) / 10**d


def fixed(x: float, d: int) -> str:
    """Number.prototype.toFixed: ties go away from zero on the exact binary value."""
    q = Decimal(1).scaleb(-d)
    return str(Decimal(x).quantize(q, rounding=ROUND_HALF_UP))


def js_num(x: float) -> str:
    """A number as JavaScript prints it in a template string (80, not 80.0)."""
    return str(int(x)) if float(x).is_integer() else repr(float(x))


def total(xs: list[float]) -> float:
    s = 0.0
    for x in xs:  # left to right like Array.reduce (Python's sum() is compensated since 3.12)
        s += x
    return s


def mean(xs: list[float]) -> float:
    return total(xs) / len(xs) if xs else math.nan


def median(xs: list[float]) -> float:
    return float(np.median(xs))


def fit_line(pts: list[tuple[float, float]]) -> tuple[float, float, int] | None:
    """Least-squares (slope, intercept, n); None with fewer than 3 points or no spread in x."""
    n = len(pts)
    if n < 3:
        return None
    mx = total([p[0] for p in pts]) / n
    my = total([p[1] for p in pts]) / n
    sxx = total([(p[0] - mx) ** 2 for p in pts])
    sxy = total([(p[0] - mx) * (p[1] - my) for p in pts])
    if sxx == 0:
        return None
    slope = sxy / sxx
    return slope, my - slope * mx, n


# ---- severities ----


def sev(share: float) -> str:
    return "problem" if share >= 0.5 else "watch" if share >= 0.15 else "info"


def gap_sev(share: float) -> str:
    return "problem" if share >= 0.25 else "watch" if share >= 0.1 else "info"


def outside(v: float, w: Range, tolerance: float) -> str | None:
    return "low" if v < w.min - tolerance else "high" if v > w.max + tolerance else None


def cap_sev(severity: str, gap: float, tolerance: float) -> str:
    return "watch" if severity == "problem" and gap < 2 * tolerance else severity


def is_timed(lap: ReportLapInput) -> bool:
    return lap.kind == "flying" and lap.valid and (lap.lap_time_s or 0) > 0


def axles(w: Wheels) -> dict[str, float]:
    return {"front": r((w.fl + w.fr) / 2, 1), "rear": r((w.rl + w.rr) / 2, 1)}


def wheels_of(s: StintLap, key: str) -> dict[str, float]:
    return axles(getattr(s, key))


def settled(s: StintLap) -> bool:
    """Only timed laps are judged against a window: out, in and incomplete laps run cold."""
    return s.kind == LapKind.FLYING


def cap(s: str) -> str:
    return s[0].upper() + s[1:]


@dataclass
class Draft:
    category: str
    kind: str
    severity: str
    laps: list[int]
    numbers: dict[str, float]
    say: Callable[[dict[str, float]], str]
    corner: Corner | None = None
    distance_m: float | None = None
    coincides: dict[str, Any] | None = None
    set_coincides: bool = False  # True: use `coincides` as given (even None)
    locate: bool = False


class _Builder:
    def __init__(self, inp: ReportInput) -> None:
        self.inp = inp
        self.laps = inp.laps
        self.corners = inp.corners
        self.timed = [lap for lap in inp.laps if is_timed(lap)]
        self.best: ReportLapInput | None = None
        for lap in self.timed:  # first of the fastest, like reduce with a strict <
            if self.best is None or (lap.lap_time_s or 0) < (self.best.lap_time_s or 0):
                self.best = lap
        bt = self.inp.traces.get(self.best.lap_no) if self.best else None
        self.best_corners = bt.corner_times_s if bt else None
        self.lap_of = {lap.lap_no: lap for lap in inp.laps}
        self.events: list[dict[str, Any]] = []

    def is_timed_no(self, n: int) -> bool:
        lap = self.lap_of.get(n)
        return lap is not None and is_timed(lap)

    def lost(self, lap_no: int) -> float | None:
        lap = self.lap_of.get(lap_no)
        if self.best and lap and is_timed(lap):
            return (lap.lap_time_s or 0) - (self.best.lap_time_s or 0)
        return None

    def lap_coincidence(self, lap_nos: list[int]) -> dict[str, Any] | None:
        xs = [v for n in lap_nos if (v := self.lost(n)) is not None]
        if not xs:
            return None
        m = mean(xs)
        if m >= RULES["min_lost_s"]:
            return {
                "scope": "lap", "lost_s": r(m),
                "laps": [n for n in lap_nos if self.lost(n) is not None],
            }  # fmt: skip
        return None

    def worst_corner(self, lap_nos: list[int]) -> tuple[Corner, float] | None:
        if self.best_corners is None or self.best is None:
            return None
        rows: list[list[float]] = []
        for n in lap_nos:
            if n != self.best.lap_no and self.is_timed_no(n):
                t = self.inp.traces.get(n)
                if t:
                    rows.append(t.corner_times_s)
        if not rows:
            return None
        top: tuple[Corner, float] | None = None
        for i, c in enumerate(self.corners):
            m = mean([t[i] - self.best_corners[i] for t in rows])
            if m >= RULES["min_corner_lost_s"] and (top is None or m > top[1]):
                top = (c, r(m))
        return top

    def add(self, d: Draft) -> None:
        laps = sorted(d.laps)
        numbers = dict(d.numbers)
        corner = d.corner
        distance = d.distance_m
        coincides = d.coincides if d.set_coincides else self.lap_coincidence(laps)
        if coincides:
            numbers["lost_s"] = coincides["lost_s"]
        tail = ""
        if d.locate:
            w = self.worst_corner(laps)
            if w:
                corner, distance = w[0], w[0].apex_m
                numbers["corner_lost_s"] = w[1]
        if coincides:
            if coincides["scope"] == "corner":
                tail = (
                    f" It coincides with {fixed(numbers['lost_s'], 2)} s lost in that corner on "
                    "those laps."
                )
            else:
                tail = (
                    f" It coincides with laps {fixed(numbers['lost_s'], 2)} s slower than the "
                    "session's best."
                )
        if d.locate and "corner_lost_s" in numbers and corner is not None:
            tail += (
                f" Most of that time went in {corner.name} "
                f"({fixed(numbers['corner_lost_s'], 2)} s)."
            )
        self.events.append({
            "id": f"{d.category}-{d.kind}-{len(self.events)}", "category": d.category,
            "kind": d.kind, "severity": d.severity, "lap_from": laps[0], "lap_to": laps[-1],
            "corner": {"id": corner.id, "name": corner.name} if corner else None,
            "distance_m": distance, "numbers": numbers, "coincides": coincides,
            "sentence": d.say(numbers) + tail,
        })  # fmt: skip


def lap_range(n: dict[str, float]) -> str:
    a, b = int(n["lap_from"]), int(n["lap_to"])
    return f"lap {a}" if a == b else f"laps {a} to {b}"


def with_range(laps: list[int], numbers: dict[str, float]) -> dict[str, float]:
    return {**numbers, "lap_from": min(laps), "lap_to": max(laps)}


def build_report(inp: ReportInput) -> dict[str, Any]:  # noqa: C901
    """The `SessionReport` of `frontend/src/api/types.ts`."""
    b = _Builder(inp)
    stats = inp.stats
    win = windows_for(inp.car_class)
    stat_of = {s.lap_no: s for s in stats or []}
    unavailable: list[dict[str, str]] = []

    # ---- tyres and brakes (stint stats) ----
    if stats is None:
        for c in ("tyres", "brakes", "conditions"):
            unavailable.append({"category": c, "reason": UNAVAILABLE_STATS})
    elif win is None:
        for c in ("tyres", "brakes"):
            unavailable.append(
                {"category": c, "reason": f"No working windows for car class {inp.car_class}."}
            )
    else:
        _tyre_events(b, stats, win)
        _brake_events(b, stats, win)
        need = RULES["best_min_set"] + RULES["best_min_others"]
        best_set = None
        if len(b.timed) >= need:
            ranked = sorted(b.timed, key=lambda x: x.lap_time_s or 0)
            k = max(RULES["best_min_set"], math.ceil(RULES["best_share"] * len(b.timed)))
            best_set = ranked[:k]
        if best_set is None or len(b.timed) - len(best_set) < RULES["best_min_others"]:
            for c in ("tyres", "brakes"):
                unavailable.append({
                    "category": c,
                    "reason": (
                        f"Too few timed laps to compare with your best laps ({len(b.timed)}, "
                        f"need at least {need})."
                    ),
                })  # fmt: skip
        else:
            _vs_best_events(b, stats, {x.lap_no for x in best_set})

    # ---- driving (traces) ----
    traced = [(n, t) for n, t in inp.traces.items() if t.aids]
    if not traced:
        unavailable.append({"category": "driving", "reason": UNAVAILABLE_TRACES})
    else:
        _driving_events(b, traced, b.best.lap_no if b.best else None)

    # ---- settings: the recording's setting events are not stored ----
    unavailable.append({"category": "settings", "reason": UNAVAILABLE_SETTINGS})

    # ---- pace ----
    _pace_events(b, len(b.timed))

    # ---- conditions ----
    if stats is not None:
        _condition_events(b, stats)

    report_laps = []
    for lap in inp.laps:
        s = stat_of.get(lap.lap_no)
        report_laps.append({
            "lap_id": lap.lap_id, "lap_no": lap.lap_no, "kind": lap.kind,
            "lap_time_s": lap.lap_time_s, "valid": lap.valid, "has_trace": lap.has_trace,
            "tyre_surface_c": axles(s.tyre_surface_c) if s else None,
            "tyre_carcass_c": axles(s.tyre_carcass_c) if s else None,
            "tyre_pressure_kpa": axles(s.tyre_pressure_kpa) if s else None,
            "brake_c": axles(s.brake_c) if s else None,
            "track_temp_c": s.track_temp_c if s else None,
            "fuel_end_l": s.fuel_end_l if s else None,
            "energy_end_pct": s.energy_end_pct if s else None,
            "settings": None,
        })  # fmt: skip
    b.events.sort(key=lambda e: (e["lap_from"], CATEGORIES.index(e["category"])))
    return {
        "session_id": inp.session_id, "car_class": inp.car_class,
        "compound": win.compound if win else "unknown", "laps": report_laps,
        "events": b.events, "windows": window_list(win) if win else [],
        "unavailable": unavailable,
    }  # fmt: skip


def _tyre_events(b: _Builder, stats: list[StintLap], win: ClassWindows) -> None:
    metrics = (
        ("tyre_surface_c", "surface temperature", "°C", 1),
        ("tyre_carcass_c", "carcass temperature", "°C", 1),
        ("tyre_pressure_kpa", "pressure", "kPa", 0),
    )
    use = [s for s in stats if settled(s)]
    for key, label, unit, d in metrics:
        for axle in AXLES:
            for direction in ("low", "high"):
                w: Window = getattr(win, key)
                tol, rng = w.tolerance, w.range_for(axle)  # type: ignore[arg-type]
                bad = [s for s in use if outside(wheels_of(s, key)[axle], rng, tol) == direction]
                if len(bad) < RULES["tyre_min_laps"]:
                    continue
                v = mean([wheels_of(s, key)[axle] for s in bad])
                gap = abs(v - (rng.min if direction == "low" else rng.max))
                laps = [s.lap_no for s in bad]
                b.add(Draft(
                    "tyres", f"{key}_{direction}",
                    cap_sev(gap_sev(gap / (rng.max - rng.min)), gap, tol), laps,
                    with_range(laps, {
                        "mean": r(v, d), "window_min": rng.min, "window_max": rng.max,
                        "n_laps": len(bad),
                    }),
                    lambda n, axle=axle, label=label, unit=unit, d=d, direction=direction: (
                        f"{cap(axle)} tyre {label} averaged {fixed(n['mean'], d)} {unit} over "
                        f"{int(n['n_laps'])} laps ({lap_range(n)}), "
                        f"{'below' if direction == 'low' else 'above'} the "
                        f"{js_num(n['window_min'])}-{js_num(n['window_max'])} {unit} window."
                    ),
                    locate=True,
                ))  # fmt: skip
    for axle in AXLES:
        tol = win.tyre_spread_c.tolerance
        sp = win.tyre_spread_c.range_for(axle)  # type: ignore[arg-type]

        def spread(s: StintLap, axle: str = axle) -> float:
            z = s.tyre_zones_c
            names = ("fl", "fr") if axle == "front" else ("rl", "rr")
            return total([abs(getattr(z.left, k) - getattr(z.right, k)) for k in names]) / 2

        bad = [s for s in use if spread(s) > sp.max + tol]
        if len(bad) < RULES["tyre_min_laps"]:
            continue
        v = mean([spread(s) for s in bad])
        laps = [s.lap_no for s in bad]
        b.add(Draft(
            "tyres", "tyre_spread", cap_sev(sev(len(bad) / len(use)), v - sp.max, tol), laps,
            with_range(laps, {"mean": r(v, 1), "window_max": sp.max, "n_laps": len(bad)}),
            lambda n, axle=axle: (
                f"{cap(axle)} tyre tread edge-to-edge temperature spread averaged "
                f"{fixed(n['mean'], 1)} °C over {int(n['n_laps'])} laps ({lap_range(n)}), above "
                f"the {js_num(n['window_max'])} °C limit."
            ),
            locate=True,
        ))  # fmt: skip


def _brake_events(b: _Builder, stats: list[StintLap], win: ClassWindows) -> None:
    use = [s for s in stats if settled(s)]
    for axle in AXLES:
        tol = win.brake_c.tolerance
        w = win.brake_c.range_for(axle)  # type: ignore[arg-type]
        for direction in ("low", "high"):
            bad = [s for s in use if outside(wheels_of(s, "brake_c")[axle], w, tol) == direction]
            if len(bad) < RULES["brake_temp_min_laps"]:
                continue
            v = mean([wheels_of(s, "brake_c")[axle] for s in bad])
            laps = [s.lap_no for s in bad]
            b.add(Draft(
                "brakes", f"brake_{direction}",
                cap_sev(
                    sev(len(bad) / len(use) * 0.6),
                    abs(v - (w.min if direction == "low" else w.max)), tol,
                ),
                laps,
                with_range(laps, {
                    "mean": r(v, 0), "window_min": w.min, "window_max": w.max, "n_laps": len(bad),
                }),
                lambda n, axle=axle, direction=direction: (
                    f"{cap(axle)} brake disc temperature averaged {fixed(n['mean'], 0)} °C over "
                    f"{int(n['n_laps'])} {'lap' if n['n_laps'] == 1 else 'laps'} "
                    f"({lap_range(n)}), {'below' if direction == 'low' else 'above'} the "
                    f"{js_num(n['window_min'])}-{js_num(n['window_max'])} °C window."
                ),
                locate=True,
            ))  # fmt: skip
    # Discs cool in the pits: an out lap's disc temperature against the timed laps before the stop.
    for i, s in enumerate(stats):
        if s.kind != LapKind.OUT or i == 0:
            continue
        before = [x for x in stats[:i] if x.kind == LapKind.FLYING]
        if not before:
            continue
        now = wheels_of(s, "brake_c")

        def avg(axle: str, before: list[StintLap] = before) -> float:
            return mean([wheels_of(x, "brake_c")[axle] for x in before])

        if any(not avg(a) > 0 for a in AXLES):
            continue
        drop = max(1 - now[a] / avg(a) for a in AXLES)
        if drop < RULES["pit_cooling_share"]:
            continue
        b.add(Draft(
            "brakes", "brake_pit_cooling", "info", [s.lap_no],
            with_range([s.lap_no], {
                "front_c": r(now["front"], 0), "rear_c": r(now["rear"], 0),
                "front_before_c": r(avg("front"), 0), "rear_before_c": r(avg("rear"), 0),
            }),
            lambda n: (
                f"Brake discs were cooler on the out lap ({lap_range(n)}): front "
                f"{fixed(n['front_c'], 0)} °C and rear {fixed(n['rear_c'], 0)} °C, against "
                f"{fixed(n['front_before_c'], 0)} °C and {fixed(n['rear_before_c'], 0)} °C on the "
                "timed laps before the stop."
            ),
        ))  # fmt: skip

    def ratio(s: StintLap) -> float:
        br = wheels_of(s, "brake_c")
        return br["front"] / br["rear"] if br["rear"] > 0 else 1.0

    rw = win.brake_front_rear_ratio.range_for("front")
    rtol = win.brake_front_rear_ratio.tolerance
    for direction in ("low", "high"):
        bad = [s for s in use if outside(ratio(s), rw, rtol) == direction]
        if len(bad) < RULES["brake_ratio_min_laps"]:
            continue
        laps = [s.lap_no for s in bad]
        mean_ratio = mean([ratio(s) for s in bad])
        b.add(Draft(
            "brakes", f"brake_imbalance_{direction}",
            cap_sev(
                sev(len(bad) / len(use)),
                abs(mean_ratio - (rw.min if direction == "low" else rw.max)), rtol,
            ),
            laps,
            with_range(laps, {
                "ratio": r(mean_ratio), "window_min": rw.min, "window_max": rw.max,
                "n_laps": len(bad),
            }),
            lambda n, direction=direction: (
                f"Front to rear disc temperature ratio averaged {fixed(n['ratio'], 2)} over "
                f"{int(n['n_laps'])} laps ({lap_range(n)}), "
                f"{'below' if direction == 'low' else 'above'} the "
                f"{js_num(n['window_min'])}-{js_num(n['window_max'])} range."
            ),
            locate=True,
        ))  # fmt: skip


def _vs_best_events(b: _Builder, stats: list[StintLap], best_nos: set[int]) -> None:
    """Tyre and brake values on the laps outside the session's best laps against the best laps'
    mean, per axle. Reported only for laps that coincide with time lost against the best lap."""
    use = [s for s in stats if settled(s)]
    best = [s for s in use if s.lap_no in best_nos]
    others = [s for s in use if s.lap_no not in best_nos]
    if not best or not others:
        return
    t, p = RULES["best_temp_diff_c"], RULES["best_pressure_diff_kpa"]
    bk = RULES["best_brake_diff_c"]
    metrics = (
        ("tyre_surface_c", "tyres", "tyre surface temperature", "°C", 1, t),
        ("tyre_carcass_c", "tyres", "tyre carcass temperature", "°C", 1, t),
        ("tyre_pressure_kpa", "tyres", "tyre pressure", "kPa", 0, p),
        ("brake_c", "brakes", "brake disc temperature", "°C", 0, bk),
    )
    for key, category, label, unit, d, min_diff in metrics:
        for axle in AXLES:
            ref = mean([wheels_of(s, key)[axle] for s in best])
            for direction in ("high", "low"):
                hit = []
                for s in others:
                    diff = wheels_of(s, key)[axle] - ref
                    if diff >= min_diff if direction == "high" else diff <= -min_diff:
                        hit.append(s)
                if len(hit) < RULES["best_min_laps"]:
                    continue
                laps = [s.lap_no for s in hit]
                if not b.lap_coincidence(laps):
                    continue
                diff = abs(mean([wheels_of(s, key)[axle] for s in hit]) - ref)
                scale = 100 if key == "brake_c" else 20
                if key == "tyre_pressure_kpa":
                    word = "higher" if direction == "high" else "lower"
                else:
                    word = "hotter" if direction == "high" else "colder"
                b.add(Draft(
                    category, f"vs_best_{key}_{direction}", gap_sev(diff / scale), laps,
                    with_range(laps, {"diff": r(diff, d), "n_laps": len(hit), "n_best": len(best)}),
                    lambda n, axle=axle, label=label, unit=unit, d=d, word=word: (
                        f"{cap(axle)} {label} ran {fixed(n['diff'], d)} {unit} {word} than on "
                        f"your {int(n['n_best'])} best laps, on {int(n['n_laps'])} laps "
                        f"({lap_range(n)})."
                    ),
                    locate=True,
                ))  # fmt: skip


def _pieces(c: Corner) -> list[tuple[float, float]]:
    """The corner's metre ranges; a corner across the start line has two."""
    if c.start_m <= c.end_m:
        return [(c.start_m, c.end_m)]
    return [(c.start_m, math.inf), (-math.inf, c.end_m)]


def _overlap(runs: list[Run], c: Corner) -> float:
    """Metres of a lap's runs inside a corner (inclusive grid metres)."""
    return total([
        max(0.0, min(e, hi) - max(s, lo) + 1) for lo, hi in _pieces(c) for s, e in runs
    ])  # fmt: skip


def _run_count(runs: list[Run], c: Corner) -> int:
    return sum(1 for s, e in runs if any(e >= lo and s <= hi for lo, hi in _pieces(c)))


def _driving_events(  # noqa: C901
    b: _Builder, traced: list[tuple[int, TraceFacts]], best_lap: int | None
) -> None:
    inp = b.inp
    corners = inp.corners
    n_traced = len(traced)
    lap_by_no = b.lap_of

    def aids(t: TraceFacts) -> AidRuns:
        assert t.aids is not None
        return t.aids

    def corner_loss(lap_nos: list[int], i: int) -> dict[str, Any] | None:
        if best_lap is None:
            return None
        bt = inp.traces.get(best_lap)
        if bt is None or i >= len(bt.corner_times_s):
            return None
        best = bt.corner_times_s[i]
        use = [x for x in lap_nos if x != best_lap and b.is_timed_no(x)]
        xs = []
        for x in use:
            t = inp.traces.get(x)
            if t is not None and i < len(t.corner_times_s):
                xs.append(t.corner_times_s[i] - best)
        if not xs:
            return None
        m = mean(xs)
        if m >= RULES["min_corner_lost_s"]:
            return {"scope": "corner", "lost_s": r(m), "laps": use}
        return None

    timed_traced = sorted(
        [(n, t) for n, t in traced if b.is_timed_no(n) and lap_by_no[n].kind == "flying"],
        key=lambda x: lap_by_no[x[0]].lap_time_s or 0,
    )
    n_best = max(RULES["best_min_set"], math.ceil(RULES["best_share"] * len(timed_traced)))
    best_set: set[int] | None = None
    if (
        len(timed_traced) >= RULES["best_min_set"] + RULES["best_min_others"]
        and len(timed_traced) - n_best >= RULES["best_min_others"]
    ):
        best_set = {n for n, _ in timed_traced[:n_best]}

    def per_corner(kind: str) -> list[tuple[Corner, int, list[dict[str, int]]]]:
        out = []
        for i, c in enumerate(corners):
            per_lap = [
                {
                    "lap": n, "m": _overlap(aids(t)[kind], c),
                    "runs": _run_count(aids(t)[kind], c),
                }
                for n, t in traced
            ]
            out.append((c, i, per_lap))
        return out

    for kind, min_laps, word in (
        ("lockup", RULES["lockup_min_laps"], "locked a wheel under braking"),
        ("wheelspin", RULES["wheelspin_min_laps"], "spun a driven wheel on the throttle"),
    ):
        for c, i, per_lap in per_corner(kind):
            hit = [x for x in per_lap if x["runs"] > 0]
            if len(hit) < min_laps:
                continue
            laps = [x["lap"] for x in hit]
            b.add(Draft(
                "driving", f"{kind}s", sev(len(hit) / n_traced), laps,
                with_range(laps, {
                    "n_laps": len(hit), "n_traced": n_traced,
                    "runs": sum(x["runs"] for x in hit),
                }),
                lambda nn, c=c, word=word: (
                    f"The car {word} at {c.name} on {int(nn['n_laps'])} of {int(nn['n_traced'])} "
                    f"traced laps ({int(nn['runs'])} times, {lap_range(nn)})."
                ),
                corner=c, distance_m=c.apex_m, coincides=corner_loss(laps, i), set_coincides=True,
            ))  # fmt: skip

    # Trend per corner: first third of the traced flying laps against the last third.
    flying = sorted(
        [(n, t) for n, t in traced if n in lap_by_no and lap_by_no[n].kind == "flying"],
        key=lambda x: x[0],
    )
    third = len(flying) // 3
    if len(flying) >= RULES["corner_trend_min_laps"] and third >= 2:
        for kind, label in (("lockup", "Lock-ups"), ("wheelspin", "Wheelspin")):
            for c, i, per_lap in per_corner(kind):
                by_lap = {x["lap"]: x["runs"] for x in per_lap}
                head = [n for n, _ in flying[:third]]
                tail = [n for n, _ in flying[-third:]]
                first = sum(by_lap.get(x, 0) for x in head)
                last = sum(by_lap.get(x, 0) for x in tail)
                if (
                    max(first, last) < RULES["corner_trend_min_count"]
                    or abs(last - first) < RULES["corner_trend_min_change"]
                ):
                    continue
                rising = last > first
                laps = [x for x in (tail if rising else head) if by_lap.get(x, 0) > 0]
                b.add(Draft(
                    "driving", f"{kind}_trend", "watch", laps,
                    {
                        **with_range(laps, {}), "n_window": third, "first_runs": first,
                        "last_runs": last, "first_lap_from": head[0],
                        "first_lap_to": head[third - 1],
                        "last_lap_from": tail[0], "last_lap_to": tail[third - 1],
                    },
                    lambda nn, c=c, label=label, rising=rising: (
                        f"{label} at {c.name} {'rose' if rising else 'fell'} from "
                        f"{int(nn['first_runs'])} in the first {int(nn['n_window'])} timed laps "
                        f"(laps {int(nn['first_lap_from'])} to {int(nn['first_lap_to'])}) to "
                        f"{int(nn['last_runs'])} in the last {int(nn['n_window'])} "
                        f"(laps {int(nn['last_lap_from'])} to {int(nn['last_lap_to'])})."
                    ),
                    corner=c, distance_m=c.apex_m, coincides=corner_loss(laps, i),
                    set_coincides=True,
                ))  # fmt: skip

    for kind, label, min_m in (
        ("abs", "ABS", RULES["abs_corner_min_m"]),
        ("tc", "Traction control", RULES["tc_corner_min_m"]),
    ):
        cands = []
        for c, i, per_lap in per_corner(kind):
            avg = mean([p["m"] for p in per_lap])
            if not avg >= min_m:
                continue
            laps = [p["lap"] for p in per_lap if p["m"] > 0]
            coincides = corner_loss(laps, i)
            vs_best: tuple[float, float] | None = None
            if best_set is not None:
                bm = mean([p["m"] for p in per_lap if p["lap"] in best_set])
                om = mean([
                    p["m"] for p in per_lap if b.is_timed_no(p["lap"]) and p["lap"] not in best_set
                ])  # fmt: skip
                diff = abs(om - bm)
                share = RULES["aid_best_diff_share"] * max(bm, 1)
                if diff >= RULES["aid_best_diff_m"] and diff >= share:
                    vs_best = (bm, om)
            # A bare description (no time lost, no clear difference from the best laps) is dropped.
            if coincides or vs_best:
                cands.append((c, avg, laps, coincides, vs_best))
        cands.sort(key=lambda x: -x[1])  # stable, like Array.sort
        for c, avg, laps, coincides, vs_best in cands[: RULES["max_aid_corners"]]:
            extra = {}
            if vs_best:
                assert best_set is not None
                extra = {
                    "best_m": r(vs_best[0], 0), "others_m": r(vs_best[1], 0),
                    "n_best": len(best_set),
                }  # fmt: skip
            b.add(Draft(
                "driving", f"{kind}_activation", "info", laps,
                with_range(laps, {
                    "avg_m": r(avg, 0), "n_laps": len(laps), "n_traced": n_traced, **extra,
                }),
                lambda nn, c=c, label=label, vs=vs_best: (
                    f"{label} was active for {fixed(nn['avg_m'], 0)} m a lap on average at "
                    f"{c.name} ({int(nn['n_laps'])} of {int(nn['n_traced'])} traced laps, "
                    f"{lap_range(nn)})."
                    + (
                        f" On your {int(nn['n_best'])} best laps it was {fixed(nn['best_m'], 0)} m "
                        f"there, on the other timed laps {fixed(nn['others_m'], 0)} m."
                        if vs else ""
                    )
                ),
                corner=c, distance_m=c.apex_m, coincides=coincides, set_coincides=True,
            ))  # fmt: skip

    # Trend across the session: flying laps only, so pit and out laps do not skew it.
    for key, label in (("abs_m", "ABS"), ("tc_m", "Traction control")):
        pts = [
            (float(lap.lap_no), inp.aid_activation[lap.lap_no][key])
            for lap in inp.laps
            if lap.kind == "flying" and lap.lap_no in inp.aid_activation
        ]
        fit = fit_line(pts)
        if fit is None or len(pts) < RULES["trend_min_laps"]:
            continue
        slope, intercept, _ = fit
        first = intercept + slope * pts[0][0]
        last = intercept + slope * pts[-1][0]
        change = last - first
        if abs(change) < RULES["trend_min_m"] or abs(change) < RULES["trend_share"] * max(first, 1):
            continue
        laps = [int(p[0]) for p in pts]
        b.add(Draft(
            "driving", f"{'abs' if key == 'abs_m' else 'tc'}_trend", "info", laps,
            with_range(laps, {"first_m": r(first, 0), "last_m": r(last, 0)}),
            lambda nn, label=label, change=change: (
                f"{label} activation per timed lap {'rose' if change > 0 else 'fell'} from about "
                f"{fixed(nn['first_m'], 0)} m to {fixed(nn['last_m'], 0)} m across {lap_range(nn)}."
            ),
        ))  # fmt: skip


def _timing_falloff(run: list[ReportLapInput]) -> tuple[float, int] | None:
    """Raw fall-off of a run of laps for a session without stint stats."""
    clean = [lap for lap in run if is_timed(lap)]
    if not clean:
        return None
    cut = median([lap.lap_time_s or 0 for lap in clean]) * SLOW_LAP_FACTOR
    fit = fit_line([
        (float(lap.lap_no), lap.lap_time_s or 0) for lap in clean if (lap.lap_time_s or 0) <= cut
    ])  # fmt: skip
    return (fit[0], fit[2]) if fit else None


def _pace_events(b: _Builder, n_timed: int) -> None:  # noqa: C901
    inp = b.inp
    laps = inp.laps
    falls: list[dict[str, Any]] = []
    if inp.stints:
        for st in inp.stints:
            c, raw = st.falloff_fuel_corrected, st.falloff
            if raw is None:
                continue
            falls.append({
                "stint": st.stint_no, "laps": [x.lap_no for x in st.laps],
                "slope": c.slope_s_per_lap if c else raw.slope_s_per_lap,
                "raw": raw.slope_s_per_lap if c else None, "n": raw.n_laps,
                "corrected": c is not None,
            })  # fmt: skip
    else:
        run: list[ReportLapInput] = []
        stint = 1
        for lap in laps:
            run.append(lap)
            if lap.kind == "in":
                f = _timing_falloff(run)
                if f:
                    falls.append({
                        "stint": stint, "laps": [x.lap_no for x in run], "slope": f[0],
                        "raw": None, "n": f[1], "corrected": False,
                    })  # fmt: skip
                run = []
                stint += 1
        if run:
            f = _timing_falloff(run)
            if f:
                falls.append({
                    "stint": stint, "laps": [x.lap_no for x in run], "slope": f[0],
                    "raw": None, "n": f[1], "corrected": False,
                })  # fmt: skip
    for f in falls:
        if f["slope"] <= -RULES["falloff_min"]:
            b.add(Draft(
                "pace", "pace_improving", "info", f["laps"],
                with_range(f["laps"], {
                    "stint_no": f["stint"], "slope_s_per_lap": r(-f["slope"]), "n_laps": f["n"],
                }),
                lambda n, f=f: (
                    f"Lap times in stint {int(n['stint_no'])} got faster by "
                    f"{fixed(n['slope_s_per_lap'], 2)} s a lap over {int(n['n_laps'])} laps"
                    + (
                        " with the fuel burnt taken out"
                        if f["corrected"] else " (no fuel correction)"
                    )
                    + "."
                ),
            ))  # fmt: skip
            continue
        if f["slope"] < RULES["falloff_min"]:
            continue
        slope = f["slope"]
        b.add(Draft(
            "pace", "pace_falloff",
            "problem" if slope >= RULES["falloff_problem"]
            else "watch" if slope >= RULES["falloff_watch"] else "info",
            f["laps"],
            with_range(f["laps"], {
                "stint_no": f["stint"], "slope_s_per_lap": r(slope), "n_laps": f["n"],
                **({"raw_slope_s_per_lap": r(f["raw"])} if f["raw"] is not None else {}),
            }),
            lambda n, f=f: (
                f"Lap times in stint {int(n['stint_no'])} got slower by "
                f"{fixed(n['slope_s_per_lap'], 2)} s a lap over {int(n['n_laps'])} laps"
                + (
                    f" with the fuel burnt taken out ({fixed(n['raw_slope_s_per_lap'], 2)} s a lap "
                    "before the correction)"
                    if f["corrected"] else " (no fuel correction)"
                )
                + "."
            ),
        ))  # fmt: skip
    pit = [lap for lap in laps if lap.kind in ("out", "in")]
    if pit:
        nums = with_range([x.lap_no for x in pit], {
            "out_laps": sum(1 for x in pit if x.kind == "out"),
            "in_laps": sum(1 for x in pit if x.kind == "in"),
        })  # fmt: skip
        b.add(Draft(
            "pace", "pit_laps", "info", [x.lap_no for x in pit], nums,
            lambda n: (
                f"{int(n['out_laps'])} out {'lap' if n['out_laps'] == 1 else 'laps'} and "
                f"{int(n['in_laps'])} in {'lap' if n['in_laps'] == 1 else 'laps'} "
                f"({lap_range(n)}) are left out of the pace."
            ),
            coincides=None, set_coincides=True,
        ))  # fmt: skip
    invalid = [lap for lap in laps if lap.kind == "flying" and not lap.valid]
    if invalid:
        b.add(Draft(
            "pace", "invalid_laps",
            "watch" if len(invalid) / max(1, n_timed + len(invalid)) > 0.3 else "info",
            [x.lap_no for x in invalid],
            with_range([x.lap_no for x in invalid], {"n_laps": len(invalid)}),
            lambda n: (
                f"{int(n['n_laps'])} {'lap was' if n['n_laps'] == 1 else 'laps were'} invalid "
                f"({lap_range(n)})."
            ),
            coincides=None, set_coincides=True,
        ))  # fmt: skip


def _truthy(x: float) -> bool:
    """JavaScript truthiness of a number: NaN and 0 are false."""
    return not math.isnan(x) and x != 0


def _used(start: float | None, end: float | None) -> float | None:
    return None if start is None or end is None or end > start else start - end


def _condition_events(b: _Builder, stats: list[StintLap]) -> None:
    inp = b.inp
    if len(stats) >= 2:
        change = stats[-1].track_temp_c - stats[0].track_temp_c
        if abs(change) >= RULES["track_temp_drift_c"]:
            laps = [s.lap_no for s in stats]
            b.add(Draft(
                "conditions", "track_temp_drift", "info", laps,
                with_range(laps, {
                    "first_c": r(stats[0].track_temp_c, 1), "last_c": r(stats[-1].track_temp_c, 1),
                    "change_c": r(change, 1),
                }),
                lambda n: (
                    f"Track temperature {'rose' if change > 0 else 'fell'} from "
                    f"{fixed(n['first_c'], 1)} °C to {fixed(n['last_c'], 1)} °C over "
                    f"{lap_range(n)}."
                ),
            ))  # fmt: skip
    for st in inp.stints:
        flying_laps = [x for x in st.laps if x.kind == LapKind.FLYING]
        fuel_pl = mean([
            u for x in flying_laps if (u := _used(x.fuel_start_l, x.fuel_end_l)) is not None
        ])  # fmt: skip
        energy_pl = mean([
            u for x in flying_laps if (u := _used(x.energy_start_pct, x.energy_end_pct)) is not None
        ])  # fmt: skip
        first = st.laps[0]
        fuel_range = first.fuel_start_l / fuel_pl if _truthy(fuel_pl) else None
        energy_range = (
            first.energy_start_pct / energy_pl
            if _truthy(energy_pl) and first.energy_start_pct is not None else None
        )  # fmt: skip
        limit = (
            None if fuel_range is None
            else "energy" if energy_range is not None and energy_range < fuel_range else "fuel"
        )  # fmt: skip
        limit_laps = energy_range if limit == "energy" else fuel_range
        # Only when the stint ran to the limit: a full load lasts at most the stint's laps plus two.
        if limit is None or len(flying_laps) < 2 or limit_laps is None:
            continue
        if limit_laps > len(st.laps) + 2:
            continue
        assert fuel_range is not None
        laps = [x.lap_no for x in st.laps]
        nums = with_range(laps, {
            "stint_no": st.stint_no, "fuel_laps": r(fuel_range, 1),
            **({"energy_laps": r(energy_range, 1)} if energy_range is not None else {}),
        })  # fmt: skip
        b.add(Draft(
            "conditions", f"{limit}_limit", "info", laps, nums,
            lambda n, limit=limit: (
                f"In stint {int(n['stint_no'])} virtual energy runs out first: a full start load "
                f"lasts about {fixed(n['energy_laps'], 1)} laps at this rate, fuel "
                f"{fixed(n['fuel_laps'], 1)} laps."
                if limit == "energy" else
                f"In stint {int(n['stint_no'])} fuel runs out first: a full start load lasts about "
                f"{fixed(n['fuel_laps'], 1)} laps at this rate"
                + (
                    f", virtual energy {fixed(n['energy_laps'], 1)} laps"
                    if "energy_laps" in n else ""
                )
                + "."
            ),
            coincides=None, set_coincides=True,
        ))  # fmt: skip


# ---- from the store ----

AID_KINDS = ("abs", "tc", "lockup", "wheelspin")
LOCKUP_SLIP = 0.9
WHEELSPIN_SLIP = 1.1
MIN_PEDAL = 0.05
MERGE_GAP_M = 2


def aid_runs(trace: LapTrace) -> AidRuns | None:
    """Where each aid was active, and where a wheel was locked (braking, any wheel) or spinning
    (on throttle, a driven wheel). None when the trace lacks the aid or slip channels."""
    from racecoach.analysis.balance import runs_of

    ch = trace.ch
    need = ("abs", "tc", "brake", "throttle", "slip_fl", "slip_fr", "slip_rl", "slip_rr")
    if any(k not in ch for k in need):
        return None
    a = {k: np.asarray(ch[k], dtype=float) for k in need}
    if all(np.all(a[k] == 1.0) for k in need[4:]):
        return None  # the importer fills a missing wheel-speed channel with 1 (no slip)
    locked = (a["brake"] > MIN_PEDAL) & np.any([a[k] < LOCKUP_SLIP for k in need[4:]], axis=0)
    spinning = (a["throttle"] > MIN_PEDAL) & np.any(
        [a[k] > WHEELSPIN_SLIP for k in ("slip_rl", "slip_rr")], axis=0
    )
    d = np.asarray(trace.distance, dtype=float)

    def metres(runs: list[Run]) -> list[Run]:
        # grid indices to lap metres: an out lap's grid starts where it left the pits, not at 0
        return [(int(round(d[x])), int(round(d[y]))) for x, y in runs]

    return {
        "abs": metres(runs_of(a["abs"] > 0, 0)), "tc": metres(runs_of(a["tc"] > 0, 0)),
        "lockup": metres(runs_of(locked, MERGE_GAP_M)),
        "wheelspin": metres(runs_of(spinning, MERGE_GAP_M)),
    }  # fmt: skip


def trace_facts(trace: LapTrace, corners: list[Corner]) -> TraceFacts:
    """The aid runs and each corner's time: `t` at the corner's end metre minus at its start (a
    corner across the start line is timed through the line)."""
    from racecoach.analysis.consistency import corner_time

    t = np.asarray(trace.ch["t"], dtype=float)
    d = np.asarray(trace.distance, dtype=float)

    def at(m: float) -> float:
        return float(t[min(len(t) - 1, max(0, int(np.searchsorted(d, m - 0.5))))])

    times = [
        corner_time(trace, c) if c.start_m > c.end_m else at(c.end_m) - at(c.start_m)
        for c in corners
    ]
    return TraceFacts(aid_runs(trace), times)
