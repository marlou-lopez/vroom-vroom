from racecoach.analysis.corners import DetectedCorner
from racecoach.tracks import Corner, Landmark, TrackMap, calibrate, load_map, map_for, save_map
from tests.synthetic import SynthCorner, make_lap


def _det(apex: float) -> DetectedCorner:
    return DetectedCorner(apex, apex - 100, apex + 100, 90.0, False)


def test_calibrate_names_with_80m_seed_offset():
    seed = TrackMap(
        track_id="x",
        length_m=2000,
        corners=[
            Corner(id="a", name="A", start_m=420, apex_m=580, end_m=700, approx=True),
            Corner(id="b", name="B", start_m=1000, apex_m=1180, end_m=1300, approx=True),
            Corner(id="c", name="C", start_m=1500, apex_m=1800, end_m=1900, approx=True),
        ],
        landmarks=[
            Landmark(id="a-board", label="100 board", kind="brake_board", distance_m=470,
                     corner_id="a", confidence="low"),
        ],
    )
    detected = [_det(500), _det(1100), _det(1400)]  # A and B off by 80 m, C absent, one extra
    res = calibrate(seed, detected)
    assert [c.apex_m for c in res.map.corners[:2]] == [500, 1100]
    assert not res.map.corners[0].approx and not res.map.corners[1].approx
    assert res.missing == ["c"]
    assert res.map.corners[2].approx
    assert [d.apex_m for d in res.unmapped] == [1400]
    assert res.map.landmarks[0].distance_m == 390


def test_map_for_drafts_and_saves_when_absent(tmp_path):
    lap = make_lap([SynthCorner(a, 90) for a in (500, 1100, 1600)])
    m = map_for(tmp_path, "new-track", lap)
    assert [c.name for c in m.corners] == ["T1", "T2", "T3"]
    assert (tmp_path / "new-track.yaml").exists()
    assert load_map(tmp_path, "new-track") == m


def test_map_for_calibrates_approx_seed(tmp_path):
    lap = make_lap([SynthCorner(500, 90)])
    save_map(tmp_path, TrackMap(track_id="s", length_m=2000, corners=[
        Corner(id="a", name="A", start_m=300, apex_m=580, end_m=700, approx=True)]))
    m = map_for(tmp_path, "s", lap)
    assert abs(m.corners[0].apex_m - 500) <= 5 and not m.corners[0].approx
    assert not load_map(tmp_path, "s").corners[0].approx  # type: ignore[union-attr]


def test_spa_seed_loads():
    from pathlib import Path

    seed_dir = Path(__file__).resolve().parents[2] / "tracks"
    m = load_map(seed_dir, "circuit-de-spa-francorchamps-circuit-de-spa-francorchamps")
    assert m is not None and len(m.corners) == 15 and all(c.approx for c in m.corners)
    assert {lm.corner_id for lm in m.landmarks} <= {c.id for c in m.corners}
