"""The model's answer (`CoachOutput`) and the stored result (`CoachResult`, the frontend
contract's `CoachResult`, `frontend/src/api/types.ts`)."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

Command = Literal["analyze", "average", "corner"]
FindingKind = Literal["issue", "minor", "strength", "inconsistent"]
CueType = Literal["landmark", "feel", "own_lap", "none"]


class FindingOut(BaseModel):
    corner_id: str
    corner: str
    kind: FindingKind
    time_s: float
    what: str = Field(min_length=1)
    fix: str = Field(min_length=1)
    cue_type: CueType
    evidence: list[str] = Field(default_factory=list, max_length=3)


class FocusOut(BaseModel):
    corner_id: str
    instruction: str = Field(min_length=1)
    metric: str = Field(min_length=1)


class CoachOutput(BaseModel):
    summary: str = Field(min_length=1)
    findings: list[FindingOut]
    focus: FocusOut | None = None
    encouragement: str | None = None


class Finding(FindingOut):
    model_config = ConfigDict(json_schema_serialization_defaults_required=True)

    id: str
    reviewed: bool = False


class Focus(FocusOut):
    pass


class CoachResult(BaseModel):
    id: str
    command: Command
    lap_id: str
    ref_lap_id: str | None
    summary: str
    findings: list[Finding]
    focus: Focus | None
    encouragement: str | None
    stats: dict[str, str]
    warnings: list[str]
    cost_usd: float | None
    created_at: str
