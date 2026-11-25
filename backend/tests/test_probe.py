from pathlib import Path

from typer.testing import CliRunner

from racecoach.cli import app
from racecoach.lmu.probe import probe


def test_probe_reports_what_the_schema_doc_says(spa_fixture: Path) -> None:
    md = probe(spa_fixture)
    # docs/lmu-duckdb-schema.md: 101 tables, registries, GPS Time as the 100 Hz clock.
    assert "- Tables: 101" in md
    assert "- Continuous channels (in `channelsList`): " in md
    for heading in ("## channelsList", "## eventsList", "## metadata", "## Head and tail rows"):
        assert heading in md
    assert "| GPS Time | 100 | s | 42700 | 100." in md
    assert "| Lap Dist | 50 | m | 21350 | 50." in md
    assert "| Lap | event | " in md
    assert "| channelsList | registry |" in md
    # Wheel channels have value1..value4, events (ts, value).
    assert "| Wheel Speed | channel |" in md and "value1 FLOAT, value2 FLOAT" in md
    assert "| TrackName | Circuit de Spa-Francorchamps |" in md
    # CarSetup is summarised, not dumped.
    assert "| CarSetup | JSON object," in md


def test_cli_probe(spa_fixture: Path) -> None:
    result = CliRunner().invoke(app, ["probe", str(spa_fixture)])
    assert result.exit_code == 0, result.output
    assert result.output.startswith("# LMU recording: spa_720s.duckdb")


def test_probe_does_not_modify_the_recording(spa_fixture: Path) -> None:
    before = spa_fixture.read_bytes()
    probe(spa_fixture)
    assert spa_fixture.read_bytes() == before
