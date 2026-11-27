"""Track maps (corners and landmarks) as YAML, drafting and calibration."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import yaml
from pydantic import BaseModel, ConfigDict

from racecoach.analysis.corners import DetectedCorner, detect_corners
from racecoach.model import LapTrace


class Corner(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: str
    name: str
    start_m: float
    apex_m: float
    end_m: float
    complex: str | None = None
    approx: bool = False


class Landmark(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: str
    label: str
    kind: Literal["brake_board", "kerb_entry", "kerb_apex", "kerb_exit", "custom"]
    distance_m: float
    corner_id: str | None = None
    confidence: Literal["low", "detected", "confirmed"]


class TrackMap(BaseModel):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    track_id: str
    length_m: float
    corners: list[Corner] = []
    landmarks: list[Landmark] = []


@dataclass
class CalibrationResult:
    map: TrackMap
    unmapped: list[DetectedCorner] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)


def _path(tracks_dir: Path | str, track_id: str) -> Path:
    return Path(tracks_dir) / f"{track_id}.yaml"


def load_map(tracks_dir: Path | str, track_id: str) -> TrackMap | None:
    path = _path(tracks_dir, track_id)
    if not path.exists():
        return None
    return TrackMap.model_validate(yaml.safe_load(path.read_text()))


def save_map(tracks_dir: Path | str, m: TrackMap) -> Path:
    path = _path(tracks_dir, m.track_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(m.model_dump(mode="json"), sort_keys=False, allow_unicode=True))
    return path


def draft_map(track_id: str, ref: LapTrace) -> TrackMap:
    corners = [
        Corner(
            id=f"t{i}",
            name=f"T{i}",
            start_m=d.start_m,
            apex_m=d.apex_m,
            end_m=d.end_m,
            approx=False,
        )
        for i, d in enumerate(detect_corners(ref), start=1)
    ]
    return TrackMap(track_id=track_id, length_m=float(ref.distance[-1]), corners=corners)


def calibrate(m: TrackMap, detected: list[DetectedCorner], tol_m: float = 150) -> CalibrationResult:
    """Match each map corner to the nearest detected apex within `tol_m` (one to one, closest
    pairs first), rewrite its distances from the detection and clear `approx`."""
    pairs = sorted(
        (abs(c.apex_m - d.apex_m), ci, di)
        for ci, c in enumerate(m.corners)
        for di, d in enumerate(detected)
        if abs(c.apex_m - d.apex_m) <= tol_m
    )
    match: dict[int, int] = {}
    used: set[int] = set()
    for _, ci, di in pairs:
        if ci not in match and di not in used:
            match[ci] = di
            used.add(di)

    corners: list[Corner] = []
    shift: dict[str, float] = {}
    missing: list[str] = []
    for ci, c in enumerate(m.corners):
        if ci in match:
            d = detected[match[ci]]
            shift[c.id] = d.apex_m - c.apex_m
            corners.append(
                c.model_copy(
                    update={
                        "start_m": d.start_m,
                        "apex_m": d.apex_m,
                        "end_m": d.end_m,
                        "approx": False,
                    }
                )
            )
        else:
            corners.append(c)
            missing.append(c.id)

    # unconfirmed landmarks follow their corner's shift; detected and confirmed ones stay put
    landmarks = [
        lm.model_copy(update={"distance_m": lm.distance_m + shift[lm.corner_id]})
        if lm.confidence == "low" and lm.corner_id in shift
        else lm
        for lm in m.landmarks
    ]
    unmapped = [d for di, d in enumerate(detected) if di not in used]
    new_map = m.model_copy(update={"corners": corners, "landmarks": landmarks})
    return CalibrationResult(map=new_map, unmapped=unmapped, missing=missing)


def map_for(tracks_dir: Path | str, track_id: str, ref: LapTrace) -> TrackMap:
    """The saved map, calibrated first when any corner is approximate; else a saved T1..Tn draft."""
    m = load_map(tracks_dir, track_id)
    if m is None:
        m = draft_map(track_id, ref)
        save_map(tracks_dir, m)
        return m
    if any(c.approx for c in m.corners):
        m = calibrate(m, detect_corners(ref)).map
        save_map(tracks_dir, m)
    return m
