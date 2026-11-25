"""The HTTP API: one shape test per route, and the behaviours the frontend relies on."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

from racecoach.api.app import create_app
from racecoach.model import GRID_CHANNELS, LapKind, LapMeta, LapSource, SessionMeta
from racecoach.settings import Settings
from racecoach.store import AppStore
from tests.coach.helpers import CORNERS, lap_id, make_session, make_store, ok_model
from tests.synthetic import make_lap

SID = "s" * 40
OTHER = "o" * 40


def add_session(
    store: AppStore, sid: str, *, track_id: str, car_id: str, laps: list[int], car_name: str = "Car"
) -> None:  # fmt: skip
    base = make_session(sid, track_id)
    meta = SessionMeta(**{**base.__dict__, "car_id": car_id, "car_name": car_name})
    pairs = []
    for no in laps:
        tr = make_lap(CORNERS, lap_id=f"{sid[:12]}-{no:03d}")
        lm = LapMeta(
            lap_id=tr.lap_id, session_id=sid, lap_no=no, kind=LapKind.FLYING,
            lap_time_s=round(float(tr.ch["t"][-1]) + 0.02, 3), sectors_s=(), valid=True,
            valid_override=None, pinned_reference=False, source=LapSource.OWN_RECORDING,
            driver="d", track_id=track_id, car_id=car_id,
        )  # fmt: skip
        pairs.append((lm, tr))
    store.add_session(
        SessionMeta(**{**meta.__dict__, "started_at": datetime(2026, 2, 1, tzinfo=UTC)}),
        pairs, "raw.duckdb",
    )  # fmt: skip


@pytest.fixture
def env(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    store, settings = make_store(tmp_path)
    monkeypatch.setattr(
        "racecoach.api.routes.run_coach",
        lambda st, se, *a, **kw: __import__("racecoach.coach.service", fromlist=["x"]).run_coach(
            st, se, *a, model=ok_model(), **kw
        ),
    )
    app = create_app(settings, store, frontend_dist=None, watch=False)
    with TestClient(app) as client:
        yield client, store, settings


def err(r: Any, status: int, code: str) -> None:
    assert r.status_code == status, r.text
    assert r.json()["code"] == code


def test_sessions_and_laps_shapes(env):
    c, _, _ = env
    s = c.get("/api/sessions").json()
    assert len(s) == 1
    assert set(s[0]) == {
        "session_id", "track_name", "track_layout", "track_id", "track_length_m", "car_name",
        "car_id", "car_class", "session_type", "game_build", "started_at", "driver",
        "steering_range_deg", "car_dims",
    }  # fmt: skip
    laps = c.get(f"/api/sessions/{SID}/laps").json()
    assert [x["lap_no"] for x in laps] == [1, 2, 3, 4]
    assert set(laps[0]) == {
        "lap_id", "session_id", "lap_no", "kind", "lap_time_s", "sectors_s", "valid",
        "valid_override", "pinned_reference", "source", "driver", "track_id", "car_id",
        "has_trace", "is_reference",
    }  # fmt: skip
    assert laps[0]["is_reference"] and laps[0]["has_trace"]
    assert not laps[1]["is_reference"]
    one = c.get(f"/api/laps/{lap_id(2)}").json()
    assert one["lap_no"] == 2 and "is_reference" in one
    err(c.get("/api/laps/nope"), 404, "unknown_lap")
    err(c.get("/api/sessions/nope/laps"), 404, "unknown_session")


def test_trace_shape_and_channels(env):
    c, _, _ = env
    t = c.get(f"/api/laps/{lap_id(1)}/trace").json()
    assert set(t["ch"]) == set(GRID_CHANNELS)
    assert len(t["distance"]) == len(t["ch"]["t"])
    some = c.get(f"/api/laps/{lap_id(1)}/trace?channels=speed_kmh,brake").json()
    assert set(some["ch"]) == {"speed_kmh", "brake"}
    err(c.get(f"/api/laps/{lap_id(1)}/trace?channels=bogus"), 422, "bad_request")


def test_pin_then_reference_flag(env):
    c, _, _ = env
    r = c.patch(f"/api/laps/{lap_id(3)}", json={"pinned_reference": True})
    assert r.status_code == 200 and r.json()["pinned_reference"] is True
    laps = {x["lap_no"]: x for x in c.get(f"/api/sessions/{SID}/laps").json()}
    assert laps[3]["is_reference"] and not laps[1]["is_reference"]
    r = c.patch(f"/api/laps/{lap_id(3)}", json={"valid_override": False})
    assert r.json()["valid_override"] is False and r.json()["pinned_reference"] is True
    r = c.patch(f"/api/laps/{lap_id(3)}", json={"valid_override": None})
    assert r.json()["valid_override"] is None


def test_shapes_match_frontend_contract(env):
    c, _, _ = env
    body = c.get("/api/compare", params={"lap": lap_id(2)}).json()
    assert set(body) == {
        "lap_id", "ref_lap_id", "lap_kind", "ref_kind", "distance", "lap", "ref", "delta",
        "warning", "lap_steering_range_deg", "ref_steering_range_deg", "lap_car_dims",
        "ref_car_dims", "lap_car_id", "ref_car_id", "lap_car_name", "ref_car_name", "corners",
        "lap_balance", "ref_balance", "lap_understeer_runs", "ref_understeer_runs",
        "lap_oversteer_runs", "ref_oversteer_runs", "ref_joins_m",
    }  # fmt: skip
    assert body["ref_lap_id"] == lap_id(1) and body["warning"] is None
    n = len(body["distance"])
    assert set(body["lap"]) == set(GRID_CHANNELS) and len(body["lap"]["t"]) == n
    assert len(body["delta"]) == n and body["delta"][0] == 0
    assert [x["corner_id"] for x in body["corners"]] == ["t1", "t2", "t3"]
    assert set(body["corners"][0]["lap"]) == {
        "brake_onset_m", "peak_brake", "min_speed_kmh", "min_speed_m", "throttle_pickup_m",
        "exit_speed_kmh", "coast_s", "overlap_s", "steer_corrections", "understeer_peak_deg_s",
        "understeer_mean_deg_s",
    }  # fmt: skip
    assert body["ref_joins_m"] == []

    tm = c.get("/api/tracks/synth-ring-gp/map").json()
    assert set(tm) == {"track_id", "length_m", "corners", "landmarks"}
    assert set(tm["corners"][0]) == {
        "id", "name", "start_m", "apex_m", "end_m", "complex", "approx"
    }  # fmt: skip
    assert set(tm["landmarks"][0]) == {
        "id", "label", "kind", "distance_m", "corner_id", "confidence"
    }  # fmt: skip

    summ = c.get(f"/api/sessions/{SID}/summary").json()
    assert set(summ) == {
        "n_laps", "n_valid", "best_lap_s", "theoretical_best_s", "track_temp_c", "focus"
    }  # fmt: skip
    assert summ["n_laps"] == 4 and summ["n_valid"] == 4
    assert summ["theoretical_best_s"] <= summ["best_lap_s"] + 0.005  # segments are rounded

    assert c.get(f"/api/sessions/{SID}/setup").json() == {"entries": []}
    ideal = c.get(f"/api/sessions/{SID}/ideal").json()
    assert set(ideal) == {"time_s", "scope", "segments"} and ideal["scope"] == "session"
    assert set(ideal["segments"][0]) == {
        "label", "corner_id", "start_m", "end_m", "best_s", "lap_id", "lap_no", "session_id"
    }  # fmt: skip
    assert c.get(f"/api/sessions/{SID}/ideal?scope=all").json()["scope"] == "all"
    st = c.get(f"/api/sessions/{SID}/segment-times").json()
    assert len(st["laps"]) == 4
    assert len(st["laps"][0]["segment_s"]) == len(ideal["segments"])
    assert c.get(f"/api/sessions/{SID}/stints").json() == []
    err(c.get("/api/sessions/nope/stints"), 404, "unknown_session")
    rep = c.get(f"/api/sessions/{SID}/report").json()
    assert set(rep) == {
        "session_id", "car_class", "compound", "laps", "events", "windows", "unavailable"
    }  # fmt: skip
    assert len(rep["laps"]) == 4
    assert c.get("/api/llm/usage").json() == {"calls": [], "total_usd": 0}
    err(c.get("/api/tracks/nope/map"), 404, "unknown_track")
    err(c.get("/api/sessions/nope/summary"), 404, "unknown_session")


def test_compare_track_mismatch_422(env):
    c, store, _ = env
    add_session(store, OTHER, track_id="elsewhere", car_id="synth-gt3", laps=[1])
    err(c.get("/api/compare", params={"lap": lap_id(2), "ref": f"{OTHER[:12]}-001"}), 422,
        "track_mismatch")  # fmt: skip
    err(c.get("/api/compare", params={"lap": "nope"}), 404, "unknown_lap")


def test_compare_other_car_warns(env):
    c, store, _ = env
    add_session(
        store, OTHER, track_id="synth-ring-gp", car_id="other-car", laps=[1], car_name="Other"
    )  # fmt: skip
    body = c.get("/api/compare", params={"lap": lap_id(2), "ref": f"{OTHER[:12]}-001"}).json()
    assert body["warning"] and "Other" in body["warning"]
    assert body["ref_car_id"] == "other-car" and body["ref_car_name"] == "Other"


def test_compare_candidates_same_layout_only(env):
    c, store, _ = env
    add_session(store, OTHER, track_id="elsewhere", car_id="synth-gt3", laps=[1])
    add_session(store, "p" * 40, track_id="synth-ring-gp", car_id="other-car", laps=[1])
    cands = c.get(f"/api/laps/{lap_id(2)}/compare-candidates").json()
    ids = [x["lap_id"] for x in cands]
    assert ids[0] == f"ideal:{SID}" and cands[0]["is_ideal"]
    assert lap_id(2) not in ids and f"{OTHER[:12]}-001" not in ids
    by = {x["lap_id"]: x for x in cands}
    assert by[lap_id(1)]["is_previous"] and by[lap_id(1)]["is_reference"]
    assert by[f"{'p' * 12}-001"]["other_car"]
    assert set(cands[1]) == {
        "lap_id", "label", "lap_time_s", "car_name", "is_reference", "is_previous", "other_car",
        "is_ideal",
    }  # fmt: skip


def test_compare_against_ideal(env):
    c, _, _ = env
    ideal_id = f"ideal:{SID}"
    body = c.get("/api/compare", params={"lap": lap_id(3), "ref": ideal_id}).json()
    assert body["ref_lap_id"] == ideal_id and body["ref_kind"] == "flying"
    assert body["ref_joins_m"] and body["ref_joins_m"] == sorted(body["ref_joins_m"])
    ideal_t = c.get(f"/api/sessions/{SID}/ideal").json()["time_s"]
    lap_time = next(
        x["lap_time_s"] for x in c.get(f"/api/sessions/{SID}/laps").json() if x["lap_no"] == 3
    )
    assert abs(body["delta"][-1] - (lap_time - ideal_t)) < 0.02
    err(c.get("/api/compare", params={"lap": lap_id(3), "ref": f"ideal:{'x' * 40}"}), 404,
        "unknown_lap")  # fmt: skip


def test_landmark_post_is_confirmed(env):
    c, _, settings = env
    r = c.post(
        "/api/tracks/synth-ring-gp/landmarks",
        json={"label": "Tree", "kind": "custom", "distance_m": 700, "corner_id": "t2"},
    )
    assert r.status_code == 200
    new = [lm for lm in r.json()["landmarks"] if lm["label"] == "Tree"]
    assert len(new) == 1 and new[0]["confidence"] == "confirmed" and new[0]["id"]
    # persisted
    saved = c.get("/api/tracks/synth-ring-gp/map").json()["landmarks"]
    assert any(lm["label"] == "Tree" for lm in saved)
    r = c.patch(
        "/api/tracks/synth-ring-gp/landmarks/t1-guess", json={"confirm": True, "distance_m": 470}
    )
    g = next(lm for lm in r.json()["landmarks"] if lm["id"] == "t1-guess")
    assert g["confidence"] == "confirmed" and g["distance_m"] == 470
    r = c.delete(f"/api/tracks/synth-ring-gp/landmarks/{new[0]['id']}")
    assert all(lm["id"] != new[0]["id"] for lm in r.json()["landmarks"])
    err(c.delete("/api/tracks/synth-ring-gp/landmarks/nope"), 404, "unknown_landmark")
    err(c.patch("/api/tracks/synth-ring-gp/landmarks/nope", json={"confirm": True}), 404,
        "unknown_landmark")  # fmt: skip


def test_calibrate_route(env):
    c, _, _ = env
    r = c.post("/api/tracks/synth-ring-gp/calibrate")
    assert r.status_code == 200
    body = r.json()
    assert set(body) == {"map", "unmapped", "missing"}
    assert body["map"]["track_id"] == "synth-ring-gp"
    assert isinstance(body["unmapped"], list) and isinstance(body["missing"], list)


def test_calibrate_without_reference_422(env):
    c, _, _ = env
    err(c.post("/api/tracks/no-laps-here/calibrate"), 422, "no_reference")


def test_coach_missing_key_502(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.chdir(tmp_path)  # no dotenv file in sight
    for k in ("OPENAI_API_KEY", "RACECOACH_OPENAI_API_KEY"):
        monkeypatch.delenv(k, raising=False)
    store, settings = make_store(tmp_path)
    settings = Settings(
        data_dir=tmp_path, tracks_dir=settings.tracks_dir,
        profile_path=settings.profile_path, openai_api_key=None,
    )  # fmt: skip
    with TestClient(create_app(settings, store, frontend_dist=None, watch=False)) as c:
        r = c.post("/api/coach", json={"command": "analyze", "lap_id": lap_id(3)})
        err(r, 502, "missing_api_key")
        usage = c.get("/api/llm/usage").json()
        assert usage["calls"] and usage["calls"][0]["ok"] is False


def test_coach_results_roundtrip_and_reviewed(env):
    c, _, _ = env
    r = c.post(
        "/api/coach", json={"command": "analyze", "lap_id": lap_id(3), "ref_lap_id": lap_id(1)}
    )
    assert r.status_code == 200, r.text
    res = r.json()
    assert res["findings"] and res["lap_id"] == lap_id(3)
    got = c.get("/api/coach/results", params={"lap": lap_id(3), "ref": lap_id(1)}).json()
    assert set(got) == {"analyze"} and got["analyze"]["id"] == res["id"]
    fid = res["findings"][0]["id"]
    f = c.patch(f"/api/coach/findings/{fid}", json={"reviewed": True}).json()
    assert f["id"] == fid and f["reviewed"] is True
    got = c.get("/api/coach/results", params={"lap": lap_id(3), "ref": lap_id(1)}).json()
    assert got["analyze"]["findings"][0]["reviewed"] is True
    err(c.patch("/api/coach/findings/nope", json={"reviewed": True}), 404, "unknown_finding")
    usage = c.get("/api/llm/usage").json()
    assert usage["calls"][0]["command"] == "coach:analyze"
    assert set(usage["calls"][0]) == {
        "command", "provider", "model", "input_tokens", "output_tokens", "cost_usd", "ok",
        "created_at",
    }  # fmt: skip


def test_analyze_lap_against_itself_returns_no_findings(env):
    c, _, _ = env
    r = c.post(
        "/api/coach", json={"command": "analyze", "lap_id": lap_id(1), "ref_lap_id": lap_id(1)}
    )
    assert r.status_code == 200
    assert r.json()["findings"] == [] and r.json()["focus"] is None
    # no reference given: the lap is the track's reference itself
    r = c.post("/api/coach", json={"command": "analyze", "lap_id": lap_id(1)})
    assert r.status_code == 200 and r.json()["findings"] == []
    assert c.get("/api/llm/usage").json()["calls"] == []  # no model was asked


def test_coach_errors_carry_codes(env):
    c, _, _ = env
    err(c.post("/api/coach", json={"command": "analyze", "lap_id": "nope"}), 404, "unknown_lap")
    err(c.post("/api/coach", json={"command": "bogus", "lap_id": lap_id(1)}), 422, "bad_request")
    err(c.post("/api/coach", json={"command": "corner", "lap_id": lap_id(2), "corner_id": "zz"}),
        404, "unknown_corner")  # fmt: skip


def test_import_route(env, tmp_path: Path):
    c, _, _ = env
    err(c.post("/api/import", json={"path": str(tmp_path / "missing.duckdb")}), 404,
        "file_not_found")  # fmt: skip
    bad = tmp_path / "bad.duckdb"
    bad.write_bytes(b"not a database")
    err(c.post("/api/import", json={"path": str(bad)}), 422, "import_failed")
    fixture = Path(__file__).parent.parent / "fixtures" / "spa_720s.duckdb"
    r = c.post("/api/import", json={"path": str(fixture)})
    assert r.status_code == 200, r.text
    first = r.json()
    assert set(first) == {"session_id", "n_laps", "skipped"} and first["skipped"] is False
    assert c.post("/api/import", json={"path": str(fixture)}).json()["skipped"] is True
    stints = c.get(f"/api/sessions/{first['session_id']}/stints")
    assert stints.status_code == 200 and stints.json()


def test_serves_frontend_dist(tmp_path: Path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>app</html>")
    (dist / "assets" / "a.js").write_text("1")
    store, settings = make_store(tmp_path / "d")
    with TestClient(create_app(settings, store, frontend_dist=dist, watch=False)) as c:
        assert c.get("/sessions").text == "<html>app</html>"  # client-side route
        assert c.get("/assets/a.js").text == "1"
        assert c.get("/api/sessions").status_code == 200
        assert c.get("/../../etc/passwd").text == "<html>app</html>"


def test_ideal_delta_ends_right_with_laps_of_different_length(tmp_path: Path):
    store, settings = make_store(tmp_path)
    # a trimmed and a longer lap
    add_session(store, OTHER, track_id="synth-ring-gp", car_id="synth-gt3", laps=[1])
    tr = store.read_trace(f"{OTHER[:12]}-001")
    short = type(tr)(tr.lap_id, tr.distance[:-12], {k: v[:-12] for k, v in tr.ch.items()})
    store.write_trace(short)
    with TestClient(create_app(settings, store, frontend_dist=None, watch=False)) as c:
        for lid in (lap_id(2), f"{OTHER[:12]}-001"):
            sid = store.lap(lid).session_id  # type: ignore[union-attr]
            body = c.get("/api/compare", params={"lap": lid, "ref": f"ideal:{sid}"}).json()
            ideal_t = c.get(f"/api/sessions/{sid}/ideal").json()["time_s"]
            lap_time = store.lap(lid).lap_time_s  # type: ignore[union-attr]
            assert abs(body["delta"][-1] - (lap_time - ideal_t)) < 0.02


def test_is_reference_false_without_reference(env):
    c, store, _ = env
    for n in (1, 2, 3, 4):
        store.set_valid_override(lap_id(n), False)
    rows = c.get(f"/api/sessions/{SID}/laps").json()
    assert all(r["is_reference"] is False for r in rows)
    assert c.get(f"/api/laps/{lap_id(1)}").json()["is_reference"] is False


def test_unknown_api_path_is_json_404_with_frontend(tmp_path: Path):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("x")
    store, settings = make_store(tmp_path / "d")
    with TestClient(create_app(settings, store, frontend_dist=dist, watch=False)) as c:
        r = c.get("/api/nothing/here")
        assert r.status_code == 404 and r.json()["code"] == "not_found"


# --- track geometry (vroom-9ki.16) ---------------------------------------------------------------

MOCK = Path(__file__).resolve().parents[3] / "frontend" / "public" / "mock"


def test_geometry_without_derived_data(env):
    c, _, _ = env
    g = c.get("/api/tracks/synth-ring-gp/geometry").json()
    assert set(g) == {
        "track_id", "length_m", "centre", "elevation_m", "survey", "aerial", "coverage",
        "transform",
    }  # fmt: skip
    assert g["track_id"] == "synth-ring-gp" and g["length_m"] == 2000.0
    assert len(g["centre"]["lat"]) == len(g["centre"]["lon"]) == 2000
    assert g["elevation_m"] is None and g["survey"] is None
    assert g["aerial"] is None and g["coverage"] is None
    assert g["transform"] == {
        "local": {
            "kind": "equirectangular", "earth_radius_m": 6371008.8,
            "origin_lat_deg": 60.0, "origin_lon_deg": 0.0,
        },
        "real_world": None,
    }  # fmt: skip
    err(c.get("/api/tracks/nowhere/geometry"), 404, "unknown_track")


def test_geometry_with_elevation_survey_and_aerial(env):
    import json
    import math

    c, _, settings = env
    # World x/z of the synthetic ring (lat 60 + 0.001 sin, lon 0.001 cos) carry a height ramp,
    # edge samples, a kerb and an aerial edge line.
    k = 6371008.8 * math.pi / 180
    x_of = lambda a: 0.001 * math.cos(a) * k * 0.5  # noqa: E731
    z_of = lambda a: 0.001 * math.sin(a) * k  # noqa: E731
    ang = [2 * math.pi * i / 2000 for i in range(2000)]
    pts = [[x_of(a), z_of(a), 100.0 + i * 0.01] for i, a in enumerate(ang)]
    d = settings.track_data_path / "synth-ring-gp"
    d.mkdir(parents=True)
    (d / "elevation.json").write_text(
        json.dumps({"points": pts, "laps": [{"start_index": 0, "end_index": 2000}]})
    )
    edges = [[x_of(a) + 1, z_of(a), 0, 4.5] for a in ang[100:1100]]
    kerbs = [[x_of(a), z_of(a), 1, "flat"] for a in ang[300:320]]
    (d / "survey.json").write_text(json.dumps({
        "edges": edges, "kerbs": kerbs, "contacts": [[x_of(0.5), z_of(0.5), "edge"]],
    }))  # fmt: skip
    (d / "aerial.json").write_text(json.dumps({
        "edges": [[x_of(0.2), z_of(0.2), 0]], "attribution": "credit",
        "kerbs": [{"side": "left", "start": [x_of(ang[10]), z_of(ang[10])],
                   "end": [x_of(ang[40]), z_of(ang[40])], "width_m": 1.4}],
    }))  # fmt: skip
    g = c.get("/api/tracks/synth-ring-gp/geometry").json()
    el = g["elevation_m"]
    assert len(el) == 2000 and el[0] == 100.0 and abs(el[1000] - 110.0) < 0.1
    s = g["survey"]
    assert len(s["left_m"]) == len(s["right_m"]) == len(s["bank_deg"]) == 2000
    assert s["left_m"][500] == 4.5 and s["left_m"][1500] is None and s["right_m"][500] is None
    assert [(k["side"], k["kind"]) for k in s["kerbs"]] == [("right", "flat")]
    assert 295 <= s["kerbs"][0]["start_m"] <= 305 and 315 <= s["kerbs"][0]["end_m"] <= 325
    assert len(s["edge_points"]) == 1 and s["kerb_outer_points"] == []
    assert 0.45 < g["coverage"]["left"] < 0.55 and g["coverage"]["right"] == 0.0
    a = g["aerial"]
    assert a["attribution"] == "credit" and a["licence_url"] is None
    assert len(a["edge_points"]) == 1
    assert a["kerbs"] == [{
        "side": "left", "start_m": 10, "end_m": 40, "kind": "flat", "width_m": 1.4,
    }]  # fmt: skip


@pytest.mark.skipif(not (MOCK / "spa-elevation-2026-11-05.json").is_file(), reason="mock data")
def test_geometry_spa_files_match_mock_shapes(env):
    """The real Spa capture and survey, on a Spa centreline, give arrays of the grid's length."""
    import json
    import shutil

    from racecoach.geometry import build_geometry

    spa = json.loads((MOCK / "spa-2026-11-03.json").read_text())["laps"]
    lap = max((x for x in spa if x.get("lap_time_s")), key=lambda x: len(x["lat"]))
    lat, lon = lap["lat"], lap["lon"]
    _, _, settings = env
    d = settings.track_data_path / "spa"
    d.mkdir(parents=True)
    for name, src in (
        ("elevation", "spa-elevation-2026-11-05"), ("survey", "spa-survey-2026-11-06"),
        ("aerial", "spa-aerial-2023"),
    ):  # fmt: skip
        shutil.copy(MOCK / f"{src}.json", d / f"{name}.json")
    g = build_geometry("spa", 7004.0, lat, lon, settings.track_data_path)
    n = len(lat)
    assert len(g["elevation_m"]) == n and sum(v is not None for v in g["elevation_m"]) > 0.9 * n
    assert len(g["survey"]["left_m"]) == n and g["coverage"]["left"] > 0.5
    assert g["survey"]["kerbs"] and g["aerial"]["edge_points"]


def test_report_lists_unavailable_categories_and_never_an_empty_pass(env):
    c, store, _ = env
    rep = c.get(f"/api/sessions/{SID}/report").json()
    reasons = {u["category"]: u["reason"] for u in rep["unavailable"]}
    assert "no stint stats" in reasons["tyres"] and "in-car setting events" in reasons["settings"]
    assert {"tyres", "brakes", "conditions", "settings"} <= set(reasons)
    for lap in rep["laps"]:
        assert lap["settings"] is None and lap["tyre_surface_c"] is None
    for e in rep["events"]:
        assert e["category"] in ("driving", "pace")  # only what the stored data can judge
        assert set(e) == {
            "id", "category", "kind", "severity", "lap_from", "lap_to", "corner", "distance_m",
            "numbers", "coincides", "sentence",
        }  # fmt: skip
    assert rep["windows"] == [] or rep["car_class"] in ("GT3", "Hypercar", "LMP2")
    err(c.get("/api/sessions/nope/report"), 404, "unknown_session")
