"""Edit the recording rates in LMU's `UserData/Telemetry/config.json`.

LMU records exactly the channels listed in that file, each at the `Frequency` given there.
Changing a rate only affects recordings made afterwards.
"""

from __future__ import annotations

import json
import shutil
from collections.abc import Mapping
from datetime import datetime
from pathlib import Path
from typing import Any

# The channels the lap grid needs at a finer rate than LMU's default of 100/10 Hz mix.
DEFAULT_RATES: dict[str, int] = {
    "Lap Dist": 50,
    "G Force Lat": 50,
    "G Force Long": 50,
    "G Force Vert": 50,
    "GPS Latitude": 50,
    "GPS Longitude": 50,
}


class UnknownChannelError(KeyError):
    """A requested channel is not in the config's `Channels` table."""

    def __init__(self, names: list[str]) -> None:
        super().__init__(names)
        self.names = names

    def __str__(self) -> str:
        return "Unknown channel(s) in config.json: " + ", ".join(repr(n) for n in self.names)


def set_channel_rates(
    config_path: Path | str,
    rates: Mapping[str, int | float],
    *,
    now: datetime | None = None,
) -> Path:
    """Set the `Frequency` of the named channels and return the backup's path.

    Every name is checked and every rate validated before anything is written, so a bad
    request leaves the file untouched (and makes no backup). The original is copied to
    `config.json.bak-%Y%m%d-%H%M%S` next to it. The file is rewritten with `indent=4`,
    as LMU writes it.
    """
    path = Path(config_path)
    config: dict[str, Any] = json.loads(path.read_text(encoding="utf-8"))
    channels: dict[str, Any] = config.get("Channels", {})

    unknown = [name for name in rates if name not in channels]
    if unknown:
        raise UnknownChannelError(unknown)
    for name, hz in rates.items():
        if isinstance(hz, bool) or hz <= 0 or hz != int(hz):
            raise ValueError(f"Rate for {name!r} must be a positive whole number of Hz, got {hz!r}")

    stamp = (now or datetime.now()).strftime("%Y%m%d-%H%M%S")
    backup = path.with_name(f"{path.name}.bak-{stamp}")
    if backup.exists():
        raise FileExistsError(f"Backup already exists, not overwriting it: {backup}")
    shutil.copy2(path, backup)

    for name, hz in rates.items():
        channels[name]["Frequency"] = int(hz)
    path.write_text(json.dumps(config, indent=4) + "\n", encoding="utf-8")
    return backup
