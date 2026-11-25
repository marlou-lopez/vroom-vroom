"""Configuration: `RACECOACH_*` environment variables and a dotenv file."""

from __future__ import annotations

from pathlib import Path
from typing import Literal

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Default models per provider: (strong, fast). Gemini and Ollama have none: name them.
DEFAULT_MODELS: dict[str, tuple[str, str]] = {
    "openai": ("gpt-6.1-terra", "gpt-6-luna"),
    "anthropic": ("claude-sonnet-5-5", "claude-haiku-5-5"),
}
REPO_ROOT = Path(__file__).resolve().parents[3]
OLLAMA_DEFAULT_BASE_URL = "http://127.0.0.1:11434/v1"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="RACECOACH_", env_file=".env", extra="ignore")

    # Paths. `data_dir` holds the metadata database, `raw/` (copies of imported recordings)
    # and `traces/` (one Parquet per lap).
    data_dir: Path = Path.home() / ".local" / "share" / "racecoach"
    lmu_telemetry_dir: Path | None = None  # the folder the watcher polls

    coach_name: str = "Engineer"
    # Track maps (YAML per track) and the driver profile the coach is told, from the repo.
    tracks_dir: Path = REPO_ROOT / "tracks"
    profile_path: Path = REPO_ROOT / "config" / "profile.yaml"

    # LLM (vroom-9ki.17: OpenAI by default, Anthropic one setting away). `llm_strong` serves
    # Analyze and Corner, `llm_fast` serves Average. OpenAI and Anthropic have default models;
    # Gemini and Ollama need both named.
    llm_provider: Literal["anthropic", "openai", "gemini", "ollama"] = "openai"
    llm_strong: str | None = None
    llm_fast: str | None = None
    # An OpenAI-compatible host (OpenRouter, Groq, DeepSeek) for "openai"; "ollama" defaults to
    # the local server.
    llm_base_url: str | None = None
    # Keys: `RACECOACH_<NAME>` or the provider's usual variable.
    anthropic_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices("RACECOACH_ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"),
    )
    openai_api_key: str | None = Field(
        default=None, validation_alias=AliasChoices("RACECOACH_OPENAI_API_KEY", "OPENAI_API_KEY")
    )
    gemini_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "RACECOACH_GEMINI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"
        ),
    )

    # Folder watcher
    watch_poll_s: float = 5.0
    watch_settle_s: float = 10.0  # a file must stay unchanged this long before import

    @model_validator(mode="after")
    def _models(self) -> Settings:
        defaults = DEFAULT_MODELS.get(self.llm_provider)
        if defaults:
            self.llm_strong = self.llm_strong or defaults[0]
            self.llm_fast = self.llm_fast or defaults[1]
        elif not self.llm_strong or not self.llm_fast:
            raise ValueError(
                f"llm_provider={self.llm_provider!r} needs RACECOACH_LLM_STRONG and "
                "RACECOACH_LLM_FAST: it has no default models"
            )
        if self.llm_provider == "ollama":
            self.llm_base_url = self.llm_base_url or OLLAMA_DEFAULT_BASE_URL
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
