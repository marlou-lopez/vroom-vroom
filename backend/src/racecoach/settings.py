"""Configuration: `RACECOACH_*` environment variables and a dotenv file."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ANTHROPIC_DEFAULT_COACH_MODEL = "claude-sonnet-5-5"
ANTHROPIC_DEFAULT_FAST_MODEL = "claude-haiku-5-5"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RACECOACH_", env_file=".env", extra="ignore")

    # Paths. `data_dir` holds the metadata database, `raw/` (copies of imported recordings)
    # and `traces/` (one Parquet per lap).
    data_dir: Path = Path.home() / ".local" / "share" / "racecoach"
    lmu_telemetry_dir: Path | None = None  # the folder the watcher polls

    coach_name: str = "Engineer"

    # LLM. Anthropic has defaults; OpenAI and Gemini need their models named.
    llm_provider: Literal["anthropic", "openai", "gemini"] = "anthropic"
    coach_model: str | None = None  # the post-session coach
    fast_model: str | None = None  # short answers

    # Folder watcher
    watch_poll_s: float = 5.0
    watch_settle_s: float = 10.0  # a file must stay unchanged this long before import

    @model_validator(mode="after")
    def _models(self) -> Settings:
        if self.llm_provider == "anthropic":
            self.coach_model = self.coach_model or ANTHROPIC_DEFAULT_COACH_MODEL
            self.fast_model = self.fast_model or ANTHROPIC_DEFAULT_FAST_MODEL
        elif not self.coach_model or not self.fast_model:
            raise ValueError(
                f"llm_provider={self.llm_provider!r} needs RACECOACH_COACH_MODEL and "
                "RACECOACH_FAST_MODEL: it has no default models"
            )
        return self

    @property
    def raw_dir(self) -> Path:
        return self.data_dir / "raw"

    @property
    def traces_dir(self) -> Path:
        return self.data_dir / "traces"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "app.duckdb"
