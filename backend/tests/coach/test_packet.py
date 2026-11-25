import json

import pytest

from racecoach.coach.errors import CoachError
from racecoach.coach.packet import build_packet
from racecoach.coach.schema import Command
from racecoach.tracks import load_map
from tests.coach.helpers import lap_id, make_store


def build(tmp_path, command: Command = "analyze", lap=2, **kw):
    store, settings = make_store(tmp_path, **kw.pop("store_kw", {}))
    return store, settings, build_packet(
        store, command, lap_id(lap), tracks_dir=settings.tracks_dir, **kw
    )  # fmt: skip


def test_packet_excludes_low_confidence_landmarks(tmp_path):
    _, _, p = build(tmp_path)
    t1 = next(c for c in p.data["corners"] if c["corner_id"] == "t1")
    assert t1["landmarks"] == ["100 board (braking reference, before the apex)"]
    assert "mystery tree" not in json.dumps(p.data)


def test_analyze_packet_snapshot(tmp_path):
    _, _, p = build(tmp_path)
    assert p.ref_lap_id == lap_id(1)  # the fastest lap is the default reference
    assert [(c.corner_id, c.kind) for c in p.corners] == [
        ("t1", "issue"), ("t2", "issue"), ("t3", "issue"),
    ]  # fmt: skip
    assert all(c.time_s >= 0.05 for c in p.corners)
    t1 = p.data["corners"][0]
    assert t1["time_s"] == f"{p.corners[0].time_s:.3f}"
    assert list(t1) == [
        "corner_id", "corner", "kind", "time_s", "likely cause", "how sure the cause is",
        "why that cause", "where in the corner the time goes", "this lap against the reference",
        "landmarks", "allowed_numbers",
    ]  # fmt: skip
    pairs = t1["this lap against the reference"]
    assert list(pairs) == [
        "minimum speed", "where the minimum speed is", "exit speed", "braking starts",
        "peak brake pressure", "throttle pickup", "time coasting", "brake and throttle together",
        "steering turning points", "ABS working", "traction control working", "wheel lock-up",
        "wheelspin", "on the rev limiter", "peak rpm", "gear at the slowest point", "on a kerb",
    ]  # fmt: skip
    assert pairs["minimum speed"] == "90 km/h against 90"
    assert pairs["wheel lock-up"] == "none against none"
    assert t1["likely cause"] == "brake" and t1["how sure the cause is"] == "high"
    assert t1["where in the corner the time goes"].startswith("entry ")
    assert set(p.data) >= {"command", "track", "car", "lap", "reference", "lap_delta", "corners"}
    assert p.data["lap_delta"] == "+2.295" and p.stats["Delta"] == "+2.295 s"
    assert {"2.295", "90"} <= set(t1["allowed_numbers"]) | {"2.295"}
    assert "90" in t1["allowed_numbers"] and "0.0" in t1["allowed_numbers"]
    assert p.focus_baselines["t1"] > 0  # the session mean of the first issue's corner time


def test_corner_packet_has_one_corner_and_a_trace(tmp_path):
    _, _, p = build(tmp_path, "corner", corner_id="t2")
    assert [c.corner_id for c in p.corners] == ["t2"]
    assert len(p.data["trace"]["lap"]) == len(p.data["trace"]["reference"]) > 10
    assert len(p.data["trace"]["columns"]) == len(p.data["trace"]["lap"][0])


def test_average_packet_pairs_slowest_with_fastest(tmp_path):
    _, _, p = build(tmp_path, "average")
    assert 1 <= len(p.corners) <= 3 and all(c.kind == "inconsistent" for c in p.corners)
    c = p.data["corners"][0]
    assert c["slowest lap against the fastest"]["laps"].endswith("against lap 1")
    assert p.ref_lap_id is None and p.stats["Laps"] == "4"


def test_no_reference_raises_before_llm(tmp_path):
    store, settings = make_store(tmp_path, laps=[(1, {})])
    with pytest.raises(CoachError) as e:  # lap 1 is the only lap, so it is its own reference
        build_packet(store, "analyze", lap_id(1), tracks_dir=settings.tracks_dir)
    assert e.value.code == "no_reference"


def test_average_with_one_lap_raises_not_enough_laps(tmp_path):
    store, settings = make_store(tmp_path, laps=[(1, {})])
    with pytest.raises(CoachError) as e:
        build_packet(store, "average", lap_id(1), tracks_dir=settings.tracks_dir)
    assert e.value.code == "not_enough_laps"


def test_unknown_corner_raises_before_llm(tmp_path):
    store, settings = make_store(tmp_path)
    for command in ("corner", "analyze"):
        with pytest.raises(CoachError) as e:
            build_packet(
                store, command, lap_id(2), corner_id="nope", tracks_dir=settings.tracks_dir
            )
        assert e.value.code == "unknown_corner"


def test_unknown_lap(tmp_path):
    store, settings = make_store(tmp_path)
    with pytest.raises(CoachError) as e:
        build_packet(store, "analyze", "missing", tracks_dir=settings.tracks_dir)
    assert e.value.code == "unknown_lap"


def test_untracked_track_uses_draft_map(tmp_path):
    store, settings = make_store(tmp_path, with_map=False)
    assert load_map(settings.tracks_dir, "synth-ring-gp") is None
    p = build_packet(store, "analyze", lap_id(2), tracks_dir=settings.tracks_dir)
    assert {c.name for c in p.corners} <= {"T1", "T2", "T3", "T4", "T5", "T6"}
    assert load_map(settings.tracks_dir, "synth-ring-gp") is not None  # the draft was saved


def test_wrap_around_corner_positions_use_the_short_way_round(tmp_path):
    from racecoach.coach.packet import offset_phrase

    assert offset_phrase(1990 - 20, 2000) == "a little before"  # 30 m before the apex over the line
    assert offset_phrase(-1970, 2000) == "a little after"
    assert offset_phrase(30) == "a little after"
