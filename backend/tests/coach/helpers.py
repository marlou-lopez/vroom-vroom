"""A store of synthetic laps and fake models for the coach tests."""

from __future__ import annotations

import json
from collections.abc import Callable
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic_ai.messages import ModelMessage, ModelRequest, ModelResponse, TextPart, UserPromptPart
from pydantic_ai.models.function import AgentInfo, FunctionModel
from pydantic_ai.profiles import ModelProfile

from racecoach.model import LapKind, LapMeta, LapSource, SessionMeta
from racecoach.settings import Settings
from racecoach.store import AppStore
from racecoach.tracks import Corner, Landmark, TrackMap, save_map
from tests.synthetic import SynthCorner, make_lap

APEXES = [500, 1100, 1600]
CORNERS = [SynthCorner(a, 90) for a in APEXES]
TMAP = TrackMap(
    track_id="synth-ring-gp",
    length_m=2000,
    corners=[
        Corner(id=f"t{i + 1}", name=f"T{i + 1}", start_m=a - 200, apex_m=a, end_m=a + 150)
        for i, a in enumerate(APEXES)
    ],
    landmarks=[
        Landmark(
            id="t1-board", label="100 board", kind="brake_board", distance_m=420,
            corner_id="t1", confidence="confirmed",
        ),
        Landmark(
            id="t1-guess", label="mystery tree", kind="custom", distance_m=480,
            corner_id="t1", confidence="low",
        ),
    ],
)  # fmt: skip
# (lap_no, make_lap kwargs): lap 1 is the fastest, so it is the default reference
LAPS: list[tuple[int, dict[str, Any]]] = [
    (1, {}),
    (2, {"brake_shift_m": -30}),
    (3, {"min_speed_delta_kmh": -12}),
    (4, {"brake_shift_m": -10}),
]


def make_session(sid: str = "s" * 40, track_id: str = "synth-ring-gp") -> SessionMeta:
    return SessionMeta(
        session_id=sid, track_name="Synth Ring", track_layout="GP", track_id=track_id,
        track_length_m=2000.0, car_name="Synth GT3 #1", car_id="synth-gt3", car_class="GT3",
        session_type="Practice", game_build="x", started_at=datetime(2026, 1, 1, tzinfo=UTC),
        driver="d", steering_range_deg=524.0,
    )  # fmt: skip


def make_store(
    tmp_path: Path, laps: list[tuple[int, dict[str, Any]]] | None = None, with_map: bool = True,
) -> tuple[AppStore, Settings]:  # fmt: skip
    store = AppStore(tmp_path / "app.duckdb", tmp_path / "traces")
    session = make_session()
    pairs = []
    for no, kw in LAPS if laps is None else laps:
        tr = make_lap(CORNERS, lap_id=f"{session.session_id[:12]}-{no:03d}", **kw)
        meta = LapMeta(
            lap_id=tr.lap_id, session_id=session.session_id, lap_no=no, kind=LapKind.FLYING,
            lap_time_s=round(float(tr.ch["t"][-1]) + 0.02, 3), sectors_s=(), valid=True,
            valid_override=None, pinned_reference=False, source=LapSource.OWN_RECORDING,
            driver="d", track_id=session.track_id, car_id=session.car_id,
        )  # fmt: skip
        pairs.append((meta, tr))
    store.add_session(session, pairs, "raw.duckdb")
    tracks = tmp_path / "tracks"
    if with_map:
        save_map(tracks, TMAP)
    settings = Settings(
        data_dir=tmp_path, tracks_dir=tracks, profile_path=tmp_path / "none.yaml",
        openai_api_key="k",
    )  # fmt: skip
    return store, settings


def lap_id(no: int) -> str:
    return f"{'s' * 12}-{no:03d}"


def prompt_of(messages: list[ModelMessage]) -> dict[str, Any]:
    for m in messages:
        if isinstance(m, ModelRequest):
            for p in m.parts:
                if isinstance(p, UserPromptPart) and isinstance(p.content, str):
                    return json.loads(p.content)
    raise AssertionError("no user prompt")


def good_answer(packet: dict[str, Any], **tweak: Any) -> dict[str, Any]:
    """A valid answer to a packet: quotes one pair per corner, nothing invented."""
    findings = []
    for c in packet["corners"]:
        sides = c.get("this lap against the reference") or c["slowest lap against the fastest"]
        pair = sides.get("minimum speed") or sides["corner time"]
        findings.append({
            "corner_id": c["corner_id"], "corner": c["corner"], "kind": c["kind"],
            "time_s": float(c["time_s"]),
            "what": f"You lost time here, with a minimum speed of {pair}.",
            "fix": "Brake a little earlier and carry more speed to the apex.",
            "cue_type": "feel", "evidence": [pair],
        })  # fmt: skip
    focus = None
    if packet["command"] == "analyze" and findings and findings[0]["kind"] == "issue":
        focus = {
            "corner_id": findings[0]["corner_id"],
            "instruction": "Brake a little earlier and carry more speed.",
            "metric": "minimum speed",
        }
    out = {
        "summary": "Most of the time went in the corners below.", "findings": findings,
        "focus": focus, "encouragement": None,
    }  # fmt: skip
    return out | tweak


def model_of(
    answer: Callable[[dict[str, Any], int], str | Exception], calls: list[int] | None = None
) -> FunctionModel:
    """A model answering with `answer(packet, call_no)`: a JSON string, or an exception to raise."""
    seen: list[int] = calls if calls is not None else []

    def fn(messages: list[ModelMessage], info: AgentInfo) -> ModelResponse:
        seen.append(1)
        out = answer(prompt_of(messages), len(seen))
        if isinstance(out, Exception):
            raise out
        return ModelResponse(parts=[TextPart(out)])

    return FunctionModel(fn, profile=ModelProfile(supports_json_schema_output=True))


def ok_model(calls: list[int] | None = None) -> FunctionModel:
    return model_of(lambda p, n: json.dumps(good_answer(p)), calls)
