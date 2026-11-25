"""Errors as `{code, message}` bodies, as `frontend/src/api/types.ts` (`ApiError`) expects."""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from racecoach.analysis.consistency import NotEnoughLaps, NoValidLaps
from racecoach.coach.errors import CoachError
from racecoach.llm import LlmError

STATUS: dict[str, int] = {
    "unknown_lap": 404, "unknown_session": 404, "unknown_track": 404, "unknown_landmark": 404,
    "unknown_finding": 404, "unknown_corner": 404, "no_trace": 404, "file_not_found": 404,
    "no_reference": 422, "track_mismatch": 422, "not_enough_laps": 422, "no_valid_laps": 422,
    "nothing_to_coach": 422, "bad_request": 422, "import_failed": 422,
    "missing_api_key": 502, "network": 502, "llm_error": 502, "invalid_output": 502,
}  # fmt: skip


class ApiError(Exception):
    def __init__(self, code: str, message: str | None = None, status: int | None = None):
        super().__init__(message or code)
        self.code = code
        self.message = message or code
        self.status = status or STATUS.get(code, 400)


def _body(code: str, message: str, status: int) -> JSONResponse:
    return JSONResponse({"code": code, "message": message}, status_code=status)


def install(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def _api(_: Request, e: ApiError) -> JSONResponse:
        return _body(e.code, e.message, e.status)

    @app.exception_handler(CoachError)
    async def _coach(_: Request, e: CoachError) -> JSONResponse:
        return _body(e.code, e.message, STATUS.get(e.code, 422))

    @app.exception_handler(LlmError)
    async def _llm(_: Request, e: LlmError) -> JSONResponse:
        code = "llm_error" if e.code == "provider" else e.code
        return _body(code, e.message, 502)

    @app.exception_handler(NoValidLaps)
    async def _no_valid(_: Request, e: NoValidLaps) -> JSONResponse:
        return _body("no_valid_laps", str(e), 422)

    @app.exception_handler(NotEnoughLaps)
    async def _not_enough(_: Request, e: NotEnoughLaps) -> JSONResponse:
        return _body("not_enough_laps", str(e), 422)

    @app.exception_handler(RequestValidationError)
    async def _invalid(_: Request, e: RequestValidationError) -> JSONResponse:
        return _body("bad_request", str(e.errors()[:1]), 422)
