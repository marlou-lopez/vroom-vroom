"""Coach failures that happen before or around the LLM call."""

from __future__ import annotations

from typing import Literal

CoachErrorCode = Literal[
    "not_enough_laps",
    "no_reference",
    "unknown_lap",
    "unknown_corner",
    "no_trace",
    "nothing_to_coach",
    "invalid_output",
]


class CoachError(Exception):
    """`build_packet` raises these before any model is called; `invalid_output` is the model's
    answer failing the schema or the structural rules twice."""

    def __init__(self, code: CoachErrorCode, message: str):
        super().__init__(message)
        self.code = code
        self.message = message
