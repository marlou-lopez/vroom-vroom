"""Edges and kerbs from telemetry when a track has no survey (vroom-ohw)."""

from __future__ import annotations

import numpy as np
import pytest
from fastapi.testclient import TestClient

from racecoach.api.app import create_app
from racecoach.edges import edge_half_widths, kerb_clusters, telemetry_edges
from tests.api.test_api import SID, add_session
from tests.coach.helpers import make_store

N = 400


def lap(side: int, edge: float, a: int, b: int, kerb: tuple[int, int] | None = None, speed=0.0):
    """One lap driving on `side` (-1 left, +1 right) between metres a and b, elsewhere centred."""
    pl, te, k = np.zeros(N), np.zeros(N), np.zeros(N)
    pl[a:b] = side * 2.0
    te[a:b] = side * edge
    if kerb:
        k[kerb[0] : kerb[1] + 1] = 1
    return {"path_lateral": pl, "track_edge": te, "kerb": k, "speed_kmh": np.full(N, speed)}


def test_sides_are_measured_separately_and_gaps_stay_none():
    left, right = edge_half_widths([lap(-1, 5.0, 50, 150), lap(1, 6.0, 100, 250)], N)
    assert left[100] == 5.0 and right[200] == 6.0
    assert left[300] is None and right[10] is None  # never measured: not interpolated
    assert left[200] is None and right[120] is not None
    # the sweep through zero near the ends of a drive is not trusted
    assert left[50] is None and left[56] == 5.0


def test_kerbs_cluster_across_laps_with_ends_from_hits():
    a = lap(1, 6.0, 0, 300, kerb=(100, 120))
    b = lap(1, 6.0, 0, 300, kerb=(102, 118))
    c = lap(-1, 6.0, 0, 300, kerb=(200, 201))  # too short
    d = lap(1, 6.0, 0, 300, kerb=(250, 270))  # one lap only
    ks = kerb_clusters([a, b, c, d], N)
    assert [(k["side"], k["kind"], k["width_m"]) for k in ks] == [("right", "other", None)]
    assert ks[0]["start_m"] == 101 and ks[0]["end_m"] == 119


def test_kerb_ends_widen_by_one_sample():
    ks = kerb_clusters([lap(-1, 6.0, 0, 300, kerb=(100, 120), speed=180.0)], N)
    assert (ks[0]["start_m"], ks[0]["end_m"]) == (90, 130)  # 50 m/s at 5 Hz = 10 m


def test_telemetry_edges_coverage():
    t = telemetry_edges([lap(1, 6.0, 0, 200)], N)
    assert t["laps"] == 1 and t["coverage"] == {"left": 0.0, "right": pytest.approx(0.5, abs=0.02)}
    assert len(t["left_m"]) == N and t["left_m"].count(None) == N


@pytest.fixture
def env(tmp_path):
    store, settings = make_store(tmp_path)
    with TestClient(create_app(settings, store, frontend_dist=None, watch=False)) as c:
        yield c, store, settings


def test_geometry_falls_back_to_telemetry_without_a_survey(env):
    c, _, _ = env
    g = c.get("/api/tracks/synth-ring-gp/geometry").json()
    t = g["telemetry"]
    assert g["survey"] is None and g["coverage"] is None
    assert len(t["left_m"]) == len(t["right_m"]) == 2000 and t["laps"] == 4
    assert t["coverage"] == {"left": 0.0, "right": 1.0}  # the synthetic laps drive the right side
    assert t["right_m"][500] == 6.0 and t["left_m"][500] is None and t["kerbs"] == []


def test_a_new_lap_refreshes_the_result_and_a_comparison_does_not(env, monkeypatch):
    c, store, _ = env
    calls = []
    import racecoach.api.routes as routes

    real = routes.telemetry_edges
    monkeypatch.setattr(routes, "telemetry_edges", lambda *a: calls.append(1) or real(*a))
    assert c.get("/api/tracks/synth-ring-gp/geometry").json()["telemetry"]["laps"] == 4
    c.get("/api/compare", params={"lap": f"{SID[:12]}-002"})
    c.get("/api/compare", params={"lap": f"{SID[:12]}-003", "ref": f"{SID[:12]}-001"})
    assert c.get("/api/tracks/synth-ring-gp/geometry").json()["telemetry"]["laps"] == 4
    assert len(calls) == 1
    add_session(store, "n" * 40, track_id="synth-ring-gp", car_id="x", laps=[1])
    assert c.get("/api/tracks/synth-ring-gp/geometry").json()["telemetry"]["laps"] == 5
    assert len(calls) == 2


def test_an_out_lap_is_placed_by_distance_not_position(env):
    import numpy as np

    from tests.api.test_api import add_session

    c, store, _ = env
    add_session(store, "n" * 40, track_id="synth-ring-gp", car_id="x", laps=[1])
    lid = f"{'n' * 12}-001"
    tr = store.read_trace(lid)
    keep = slice(500, 1000)  # an out-lap leaving the pits at 500 m
    tr2 = type(tr)(lid, tr.distance[keep], {k: v[keep].copy() for k, v in tr.ch.items()})
    tr2.ch["track_edge"][:] = -3.0
    tr2.ch["path_lateral"][:] = -1.0
    store.write_trace(tr2)
    t = c.get("/api/tracks/synth-ring-gp/geometry").json()["telemetry"]
    left = np.array([np.nan if x is None else x for x in t["left_m"]])
    assert not np.isnan(left[510:990]).any() and np.isnan(left[:495]).all()
