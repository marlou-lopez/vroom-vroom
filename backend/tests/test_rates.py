import json
from datetime import datetime
from pathlib import Path

import pytest
from typer.testing import CliRunner

from racecoach.cli import app
from racecoach.lmu.rates import DEFAULT_RATES, UnknownChannelError, set_channel_rates

CONFIG = {
    "Channels": {
        "Lap Dist": {"Frequency": 10, "Name": "Lap Dist"},
        "G Force Lat": {"Frequency": 10, "Name": "G Force Lat"},
        "G Force Long": {"Frequency": 10, "Name": "G Force Long"},
        "G Force Vert": {"Frequency": 10, "Name": "G Force Vert"},
        "GPS Latitude": {"Frequency": 10, "Name": "GPS Latitude"},
        "GPS Longitude": {"Frequency": 10, "Name": "GPS Longitude"},
        "Ground Speed": {"Frequency": 100, "Name": "Ground Speed"},
    },
    "Events": {"Lap": {"Name": "Lap"}},
}


def write_config(tmp_path: Path) -> Path:
    path = tmp_path / "config.json"
    path.write_text(json.dumps(CONFIG, indent=4))
    return path


def test_rates_updates_only_named_channels_and_backs_up(tmp_path: Path) -> None:
    path = write_config(tmp_path)
    original = path.read_text()

    backup = set_channel_rates(path, {"Lap Dist": 50}, now=datetime(2026, 11, 25, 13, 5, 9))

    assert backup.name == "config.json.bak-20261125-130509"
    assert backup.read_text() == original
    new = json.loads(path.read_text())
    assert new["Channels"]["Lap Dist"]["Frequency"] == 50
    assert new["Channels"]["Ground Speed"]["Frequency"] == 100
    assert new["Channels"]["G Force Lat"]["Frequency"] == 10
    assert new["Events"] == CONFIG["Events"]
    assert path.read_text().startswith('{\n    "Channels"')  # indent=4


def test_rates_unknown_channel_raises_and_leaves_file(tmp_path: Path) -> None:
    path = write_config(tmp_path)
    original = path.read_text()

    with pytest.raises(UnknownChannelError, match="Nope"):
        set_channel_rates(path, {"Lap Dist": 50, "Nope": 50})

    assert path.read_text() == original
    assert list(tmp_path.iterdir()) == [path]  # no backup either


@pytest.mark.parametrize("bad", [0, -5, 2.5, True])
def test_rates_invalid_rate_raises_and_leaves_file(tmp_path: Path, bad: float) -> None:
    path = write_config(tmp_path)
    original = path.read_text()
    with pytest.raises(ValueError):
        set_channel_rates(path, {"Lap Dist": bad})
    assert path.read_text() == original
    assert list(tmp_path.iterdir()) == [path]


def test_cli_rates_apply_sets_the_six_channels_to_50hz(tmp_path: Path) -> None:
    path = write_config(tmp_path)
    result = CliRunner().invoke(app, ["rates", "apply", str(path)])
    assert result.exit_code == 0, result.output
    channels = json.loads(path.read_text())["Channels"]
    for name in DEFAULT_RATES:
        assert channels[name]["Frequency"] == 50
    assert channels["Ground Speed"]["Frequency"] == 100
    assert len(list(tmp_path.glob("config.json.bak-*"))) == 1


def test_cli_rates_apply_unknown_channel_exits_1(tmp_path: Path) -> None:
    path = tmp_path / "config.json"
    path.write_text(json.dumps({"Channels": {"Lap Dist": {"Frequency": 10}}}))
    result = CliRunner().invoke(app, ["rates", "apply", str(path)])
    assert result.exit_code == 1
