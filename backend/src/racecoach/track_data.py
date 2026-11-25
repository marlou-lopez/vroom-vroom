"""Install a track's derived geometry data (elevation, survey, aerial) into `track_data_dir`.

The files come from the repo's mock folder (`frontend/public/mock`), where the Spa capture, survey
and aerial edges already live; they are copied, never committed again. The aerial file keeps its
attribution and licence fields because it is copied as is.
"""

from __future__ import annotations

import shutil
from dataclasses import dataclass
from pathlib import Path

# Spa's `track_id` as the importer derives it from LMU's names (see `lmu/reader.py`).
SPA_TRACK_ID = "circuit-de-spa-francorchamps-circuit-de-spa-francorchamps"

# preset -> (default track id, part -> file name in the mock folder)
PRESETS: dict[str, tuple[str, dict[str, str]]] = {
    "spa": (
        SPA_TRACK_ID,
        {
            "elevation": "spa-elevation-2026-11-05.json",
            "survey": "spa-survey-2026-11-06.json",
            "aerial": "spa-aerial-2023.json",
        },
    ),
}


class TrackDataError(Exception):
    pass


@dataclass(frozen=True)
class Installed:
    part: str
    path: Path
    written: bool  # False: the file existed and `force` was off


def default_source_dir() -> Path:
    """`frontend/public/mock` of the checkout this package runs from."""
    for parent in Path(__file__).resolve().parents:
        cand = parent / "frontend" / "public" / "mock"
        if cand.is_dir():
            return cand
    raise TrackDataError("Cannot find frontend/public/mock; pass --source.")


def install_track_data(
    preset: str,
    track_data_dir: Path,
    *,
    source_dir: Path | None = None,
    track_id: str | None = None,
    force: bool = False,
) -> list[Installed]:
    if preset not in PRESETS:
        raise TrackDataError(f"Unknown preset {preset!r}; known: {', '.join(sorted(PRESETS))}.")
    default_id, files = PRESETS[preset]
    src = source_dir or default_source_dir()
    missing = [str(src / n) for n in files.values() if not (src / n).is_file()]
    if missing:
        raise TrackDataError("Missing source files: " + ", ".join(missing))
    dest = track_data_dir / (track_id or default_id)
    dest.mkdir(parents=True, exist_ok=True)
    out: list[Installed] = []
    for part, name in files.items():
        target = dest / f"{part}.json"
        write = force or not target.exists()
        if write:
            shutil.copyfile(src / name, target)
        out.append(Installed(part, target, write))
    return out
