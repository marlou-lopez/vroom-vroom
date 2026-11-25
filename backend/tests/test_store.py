import hashlib
import os
from dataclasses import replace
from pathlib import Path

import duckdb
import numpy as np
import pytest

from racecoach.importer import import_file
from racecoach.lmu.laps import build_laps
from racecoach.model import LapKind, LapMeta
from racecoach.settings import Settings
from racecoach.store import AppStore
from tests.synthetic import SynthCorner, make_raw_session

CORNERS = [SynthCorner(500, 90), SynthCorner(1200, 70, -1)]


@pytest.fixture
def store(tmp_path: Path):
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s:
        yield s


def _add(store: AppStore, n_laps: int = 4, **kw) -> list[LapMeta]:
    raw = make_raw_session(n_laps, CORNERS, lap_time_jitter_s=0.3, **kw)
    laps = build_laps(raw)
    store.add_session(raw.meta, laps, "raw.duckdb")
    return [lap for lap, _ in laps]


def _flying(store: AppStore) -> list[LapMeta]:
    return sorted(
        (lap for lap in store.laps() if lap.kind == LapKind.FLYING), key=lambda x: x.lap_time_s or 0
    )


def test_reference_is_best_valid_flying(store: AppStore):
    metas = _add(store)
    best = _flying(store)[0]
    ref = store.reference_for(metas[0].track_id, metas[0].car_id)
    assert ref is not None and ref.lap_id == best.lap_id
    assert ref.kind == LapKind.FLYING


def test_pin_overrides_best_and_unpins_previous(store: AppStore):
    metas = _add(store)
    fly = _flying(store)
    t, c = metas[0].track_id, metas[0].car_id
    store.pin_reference(fly[-1].lap_id)
    ref = store.reference_for(t, c)
    assert ref is not None and ref.lap_id == fly[-1].lap_id
    store.pin_reference(fly[1].lap_id)
    pinned = [lap.lap_id for lap in store.laps() if lap.pinned_reference]
    assert pinned == [fly[1].lap_id]
    store.unpin_reference(fly[1].lap_id)
    ref = store.reference_for(t, c)
    assert ref is not None and ref.lap_id == fly[0].lap_id


def test_valid_override_false_excludes_from_reference(store: AppStore):
    metas = _add(store)
    fly = _flying(store)
    t, c = metas[0].track_id, metas[0].car_id
    store.set_valid_override(fly[0].lap_id, False)
    ref = store.reference_for(t, c)
    assert ref is not None and ref.lap_id == fly[1].lap_id
    store.set_valid_override(fly[0].lap_id, None)
    ref = store.reference_for(t, c)
    assert ref is not None and ref.lap_id == fly[0].lap_id


def test_valid_override_true_rescues_an_invalid_lap(store: AppStore):
    metas = _add(store, invalid_laps=(2,))
    t, c = metas[0].track_id, metas[0].car_id
    invalid = next(lap for lap in store.laps() if lap.kind == LapKind.FLYING and not lap.valid)
    ref = store.reference_for(t, c)
    assert ref is not None and ref.lap_id != invalid.lap_id
    store.set_valid_override(invalid.lap_id, True)
    assert store.lap(invalid.lap_id) == replace(invalid, valid_override=True)


def test_reference_none_when_no_valid_flying_lap(store: AppStore):
    metas = _add(store)
    t, c = metas[0].track_id, metas[0].car_id
    for lap in _flying(store):
        store.set_valid_override(lap.lap_id, False)
    assert store.reference_for(t, c) is None
    assert store.reference_for("nowhere", c) is None


def test_trace_roundtrip_parquet(tmp_path: Path):
    raw = make_raw_session(2, CORNERS)
    laps = build_laps(raw)
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s:
        s.add_session(raw.meta, laps, "raw.duckdb")
        for lap, trace in laps:
            back = s.read_trace(lap.lap_id)
            assert s.trace_path(lap.lap_id).suffix == ".parquet"
            np.testing.assert_array_equal(back.distance, trace.distance)
            assert list(back.ch) == list(trace.ch)
            for name, arr in trace.ch.items():
                np.testing.assert_array_equal(back.ch[name], arr)
        assert len(s.sessions()) == 1 and s.sessions()[0] == raw.meta
    with AppStore(tmp_path / "app.duckdb", tmp_path / "traces") as s2:  # survives a reopen
        assert [x for x in s2.laps()] == [lap for lap, _ in laps]


def test_failed_insert_leaves_no_trace_files(store: AppStore):
    raw = make_raw_session(2, CORNERS)
    laps = build_laps(raw)
    store.add_session(raw.meta, laps, "raw.duckdb")
    before = sorted(p.name for p in store.traces_dir.iterdir())
    with pytest.raises(ValueError, match="already"):
        store.add_session(raw.meta, laps, "raw.duckdb")
    assert sorted(p.name for p in store.traces_dir.iterdir()) == before


def test_llm_log_and_focus_items(store: AppStore):
    store.log_llm_call(purpose="coach", provider="anthropic", model="m", cost_usd=0.02)
    store.log_llm_call(purpose="coach", provider="anthropic", model="m", cost_usd=0.03, ok=False)
    assert len(store.llm_calls()) == 2 and store.llm_cost_total() == pytest.approx(0.05)
    i = store.add_focus_item("spa", "gt3", "Brake later into Les Combes")
    store.add_focus_item("monza", "gt3", "Use the kerb")
    store.set_focus_status(i, "done")
    assert [f["text"] for f in store.focus_items(track_id="spa")] == ["Brake later into Les Combes"]
    assert store.focus_items(status="open")[0]["track_id"] == "monza"


def test_import_copies_raw_and_is_idempotent(store: AppStore, spa_fixture: Path, tmp_path: Path):
    sha_before = hashlib.sha1(spa_fixture.read_bytes()).hexdigest()
    raw_dir = tmp_path / "raw"
    first = import_file(store, spa_fixture, raw_dir)
    assert first.imported and first.lap_count > 0 and first.session_id == sha_before
    copy = raw_dir / f"{sha_before}.duckdb"
    assert copy.is_file() and hashlib.sha1(copy.read_bytes()).hexdigest() == sha_before
    assert hashlib.sha1(spa_fixture.read_bytes()).hexdigest() == sha_before
    n_laps = len(store.laps())
    again = import_file(store, spa_fixture, raw_dir)
    assert not again.imported and again.lap_count == first.lap_count
    assert len(store.laps()) == n_laps and len(store.sessions()) == 1
    assert len(list(store.traces_dir.glob("*.parquet"))) == n_laps


def test_failed_import_removes_the_raw_copy(store: AppStore, tmp_path: Path):
    bad = tmp_path / "bad.duckdb"
    bad.write_bytes(b"not a database")
    raw_dir = tmp_path / "raw"
    with pytest.raises(duckdb.Error):
        import_file(store, bad, raw_dir)
    assert list(raw_dir.iterdir()) == [] and store.sessions() == []


def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for k in [k for k in os.environ if k.startswith("RACECOACH_")]:
        monkeypatch.delenv(k)
    monkeypatch.chdir(tmp_path)


def test_settings_defaults_openai(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _clean_env(monkeypatch, tmp_path)
    s = Settings()
    assert s.coach_name == "Engineer" and s.llm_provider == "openai"
    assert s.llm_strong == "gpt-6.1-terra" and s.llm_fast == "gpt-6-luna"


def test_settings_anthropic_defaults(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _clean_env(monkeypatch, tmp_path)
    monkeypatch.setenv("RACECOACH_LLM_PROVIDER", "anthropic")
    s = Settings()
    assert s.llm_strong == "claude-sonnet-5-5" and s.llm_fast == "claude-haiku-5-5"


def test_settings_requires_model_for_gemini(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _clean_env(monkeypatch, tmp_path)
    monkeypatch.setenv("RACECOACH_LLM_PROVIDER", "gemini")
    with pytest.raises(ValueError, match="LLM_STRONG"):
        Settings()
    monkeypatch.setenv("RACECOACH_LLM_STRONG", "big")
    monkeypatch.setenv("RACECOACH_LLM_FAST", "small")
    assert Settings().llm_strong == "big"


def test_settings_derived_paths(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    _clean_env(monkeypatch, tmp_path)
    monkeypatch.setenv("RACECOACH_DATA_DIR", str(tmp_path / "d"))
    s = Settings()
    assert s.raw_dir == tmp_path / "d" / "raw" and s.db_path.name == "app.duckdb"


def test_session_setup_round_trip_and_session_without_one(store: AppStore) -> None:
    raw = make_raw_session(2, CORNERS)
    store.add_session(raw.meta, build_laps(raw), "raw.duckdb", setup={"VM_REAR_WING": "6.7 deg"})
    assert store.session_setup(raw.meta.session_id) == {"VM_REAR_WING": "6.7 deg"}
    other = replace(raw.meta, session_id="b" * 40)
    store.add_session(other, build_laps(replace(raw, meta=other)), "raw.duckdb")
    assert store.session_setup(other.session_id) == {}  # also what a pre-setup import looks like


def test_setup_label() -> None:
    from racecoach.setup_labels import setup_label

    assert setup_label("VM_REAR_WING") == "Rear wing"
    assert setup_label("WM_CAMBER-W_FL") == "Front left camber"
    assert setup_label("VM_UNKNOWN") == "VM_UNKNOWN"
