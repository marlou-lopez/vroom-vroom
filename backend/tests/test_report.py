"""The session report's rules and windows against the frontend's (vroom-jx6).

`tests/fixtures/report_golden.json` is written by `frontend/src/lib/reportGolden.test.ts` from the
TypeScript rules on the mock recordings (Spa and Monza practice, the Spa and Monza races), without
the in-car setting events, which the backend does not store. The Python rules must give the same
events, laps, windows and unavailable categories; the frontend test fails when the TypeScript side
changes without the golden being regenerated, so a change on either side shows up here or there.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from racecoach.report import (
    ReportInput,
    ReportLapInput,
    TraceFacts,
    build_report,
    fixed,
    js_num,
    r,
)
from racecoach.report_windows import CLASS_WINDOWS, window_list
from racecoach.stint import StintLap, fuel_effect_for, split_stints
from racecoach.tracks import Corner

GOLDEN = json.loads((Path(__file__).parent / "fixtures" / "report_golden.json").read_text())
CASES = GOLDEN["cases"]


def runs(aids: dict[str, Any]) -> dict[str, list[tuple[int, int]]]:
    return {k: [(x["start"], x["end"]) for x in v] for k, v in aids.items()}


def to_input(raw: dict[str, Any]) -> ReportInput:
    stats = None if raw["stats"] is None else [StintLap(**s) for s in raw["stats"]]
    return ReportInput(
        session_id=raw["session_id"],
        car_class=raw["car_class"],
        laps=[ReportLapInput(**lap) for lap in raw["laps"]],
        stats=stats,
        stints=split_stints(stats, fuel_effect_for(raw["car_class"])) if stats else [],
        corners=[Corner(**c) for c in raw["corners"]],
        traces={
            t["lap_no"]: TraceFacts(
                None if t["aids"] is None else runs(t["aids"]),
                t["corner_times_s"],
            )
            for t in raw["traces"]
        },
        aid_activation={
            a["lap_no"]: {"abs_m": a["abs_m"], "tc_m": a["tc_m"]} for a in raw["aid_activation"]
        },
    )  # fmt: skip


def lists_equal(a: Any, b: Any, path: str = "") -> None:
    """Structural equality; numbers compare equal when they differ by float noise only."""
    if isinstance(a, dict) and isinstance(b, dict):
        assert a.keys() == b.keys(), f"{path}: keys {sorted(a)} != {sorted(b)}"
        for k in a:
            lists_equal(a[k], b[k], f"{path}.{k}")
    elif isinstance(a, list) and isinstance(b, list):
        assert len(a) == len(b), f"{path}: {len(a)} items != {len(b)}"
        for i, (x, y) in enumerate(zip(a, b, strict=True)):
            lists_equal(x, y, f"{path}[{i}]")
    elif isinstance(a, int | float) and isinstance(b, int | float) and not isinstance(a, bool):
        assert a == pytest.approx(b, abs=1e-9), f"{path}: {a} != {b}"
    else:
        assert a == b, f"{path}: {a!r} != {b!r}"


def test_golden_has_the_mock_sessions() -> None:
    assert len(CASES) >= 4
    assert any(c["report"]["events"] for c in CASES)
    kinds = {e["category"] for c in CASES for e in c["report"]["events"]}
    assert {"tyres", "brakes", "driving", "pace"} <= kinds


@pytest.mark.parametrize("case", CASES, ids=[c["input"]["session_id"][:8] for c in CASES])
def test_events_match_the_typescript_rules(case: dict[str, Any]) -> None:
    got = build_report(to_input(case["input"]))
    want = case["report"]
    lists_equal(got["events"], want["events"], "events")
    lists_equal(got["laps"], want["laps"], "laps")
    assert got["compound"] == want["compound"]
    lists_equal(got["windows"], want["windows"], "windows")
    # The backend never has setting events, so settings is unavailable here with its own reason.
    ours = [u for u in got["unavailable"] if u["category"] != "settings"]
    theirs = [u for u in want["unavailable"] if u["category"] != "settings"]
    assert ours == theirs
    assert [u["category"] for u in got["unavailable"]].count("settings") == 1


def test_windows_match_reportwindows_ts() -> None:
    """The Python table and the one in reportWindows.ts disagree -> this fails."""
    assert set(CLASS_WINDOWS) == set(GOLDEN["windows"])
    for name, w in CLASS_WINDOWS.items():
        assert w.compound == GOLDEN["windows"][name]["compound"]
        lists_equal(window_list(w), GOLDEN["windows"][name]["windows"], name)


def test_categories_without_input_are_unavailable_not_empty() -> None:
    laps = [ReportLapInput(f"l{n}", n, "flying", 100.0 + n, True, False) for n in (1, 2, 3)]
    rep = build_report(ReportInput("s", "GT3", laps, None, [], []))
    cats = {u["category"]: u["reason"] for u in rep["unavailable"]}
    assert {"tyres", "brakes", "conditions", "driving", "settings"} <= set(cats)
    assert "no stint stats" in cats["tyres"]
    assert rep["events"] == [] or all(e["category"] == "pace" for e in rep["events"])
    unknown = build_report(ReportInput("s", "Prototype", laps, [], [], []))
    assert unknown["windows"] == [] and unknown["compound"] == "unknown"


def test_javascript_number_helpers() -> None:
    assert r(2.5, 0) == 3 and r(-2.5, 0) == -2 and r(1.005, 2) == 1.0
    assert fixed(2.5, 0) == "3" and fixed(0.125, 2) == "0.13" and fixed(1.0, 1) == "1.0"
    assert js_num(80.0) == "80" and js_num(79.4) == "79.4"


def test_trace_facts_use_metres_not_grid_indices() -> None:
    import numpy as np

    from racecoach.model import LapTrace
    from racecoach.report import trace_facts

    n = 400
    ch = {k: np.zeros(n) for k in ("abs", "tc", "brake", "throttle")}
    ch |= {k: np.ones(n) for k in ("slip_fl", "slip_fr", "slip_rl", "slip_rr")}
    ch["t"] = np.arange(n, dtype=float) * 0.05
    ch["slip_fl"][300] = 0.5  # locked while braking at index 300 = metre 1800
    ch["brake"][300] = 1.0
    ch["abs"][10:13] = 1.0
    out_lap = LapTrace("x", 1500.0 + np.arange(n), ch)
    corner = Corner(id="c", name="C", start_m=1790, apex_m=1800, end_m=1810)
    f = trace_facts(out_lap, [corner])
    assert f.aids is not None
    assert f.aids["lockup"] == [(1800, 1800)] and f.aids["abs"] == [(1510, 1512)]
    assert f.corner_times_s == [pytest.approx(1.0)]
    # a missing wheel-speed channel (the importer fills slip with 1) is not an empty pass
    for k in ("slip_fl", "slip_fr", "slip_rl", "slip_rr"):
        ch[k][:] = 1.0
    assert trace_facts(LapTrace("x", np.arange(n, dtype=float), ch), [corner]).aids is None
