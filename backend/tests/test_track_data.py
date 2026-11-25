from __future__ import annotations

from pathlib import Path

import pytest
from typer.testing import CliRunner

from racecoach.cli import app
from racecoach.track_data import SPA_TRACK_ID, TrackDataError, install_track_data

MOCK = Path(__file__).resolve().parents[2] / "frontend" / "public" / "mock"
pytestmark = pytest.mark.skipif(
    not (MOCK / "spa-elevation-2026-11-05.json").is_file(), reason="mock data"
)


def test_install_then_second_run_changes_nothing(tmp_path: Path):
    first = install_track_data("spa", tmp_path, source_dir=MOCK)
    assert [i.part for i in first] == ["elevation", "survey", "aerial"]
    assert all(i.written and i.path.is_file() for i in first)
    assert first[0].path.parent == tmp_path / SPA_TRACK_ID
    aerial = first[2].path
    assert '"attribution"' in aerial.read_text()
    aerial.write_text("edited")
    second = install_track_data("spa", tmp_path, source_dir=MOCK)
    assert not any(i.written for i in second) and aerial.read_text() == "edited"
    forced = install_track_data("spa", tmp_path, source_dir=MOCK, force=True)
    assert all(i.written for i in forced) and aerial.read_text() != "edited"


def test_unknown_preset_and_missing_source(tmp_path: Path):
    with pytest.raises(TrackDataError):
        install_track_data("nowhere", tmp_path)
    with pytest.raises(TrackDataError):
        install_track_data("spa", tmp_path, source_dir=tmp_path / "empty")


def test_cli(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RACECOACH_TRACK_DATA_DIR", str(tmp_path))
    r = CliRunner().invoke(app, ["track-data", "install", "spa", "--source", str(MOCK)])
    assert r.exit_code == 0, r.output
    assert r.output.count("wrote") == 3
    r = CliRunner().invoke(app, ["track-data", "install", "spa", "--source", str(MOCK)])
    assert r.output.count("kept") == 3
