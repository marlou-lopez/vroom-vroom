"""One typed multi-provider LLM interface and per-call cost (vroom-9ki.11).

Pydantic AI does the provider adapters and retries; this module only picks the model for a tier,
checks the key, prices a call and turns provider failures into `LlmError`.

Structured output: callers should ask for a JSON schema (`NativeOutput`), not tool calls. A host
that only has `json_object` mode (DeepSeek chat) needs the schema in the prompt (`PromptedOutput`).
"""

from __future__ import annotations

from typing import Literal

from genai_prices import Usage as PriceUsage
from genai_prices import calc_price
from pydantic_ai.exceptions import (
    ModelAPIError,
    ModelConnectionError,
    ModelHTTPError,
    ModelRequestTimeout,
)
from pydantic_ai.models import Model
from pydantic_ai.models.anthropic import AnthropicModel, AnthropicModelSettings
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.google import GoogleProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.usage import RequestUsage, RunUsage

from racecoach.settings import Settings

Tier = Literal["strong", "fast"]
LlmErrorCode = Literal["missing_api_key", "network", "provider"]

# Provider setting -> Pydantic AI model-id prefix, which genai-prices also uses to find prices.
PREFIX = {"anthropic": "anthropic", "openai": "openai", "gemini": "google-gla"}
# Model ids with these prefixes are never priced (local, or an unknown OpenAI-compatible host).
UNPRICED_PREFIXES = ("ollama", "openai-compat")


class LlmError(Exception):
    def __init__(self, code: LlmErrorCode, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def model_id(settings: Settings, tier: Tier) -> str:
    """`anthropic:…`, `openai:…`, `google-gla:…`; `ollama:…` and `openai-compat:…` are unpriced."""
    name = settings.llm_strong if tier == "strong" else settings.llm_fast
    assert name, "Settings fills both models in"
    if settings.llm_provider == "ollama":
        return f"ollama:{name}"
    if settings.llm_provider == "openai" and settings.llm_base_url:
        return f"openai-compat:{name}"
    return f"{PREFIX[settings.llm_provider]}:{name}"


def _key(settings: Settings) -> str | None:
    return {
        "anthropic": settings.anthropic_api_key,
        "openai": settings.openai_api_key,
        "gemini": settings.gemini_api_key,
        "ollama": "ollama",  # the local server takes any key
    }[settings.llm_provider]


def make_model(settings: Settings, tier: Tier) -> Model:
    key = _key(settings)
    if not key:
        raise LlmError(
            "missing_api_key",
            f"No API key for {settings.llm_provider}: set RACECOACH_{settings.llm_provider.upper()}"
            "_API_KEY (or the provider's usual variable) in the environment or the dotenv file",
        )
    name = model_id(settings, tier).split(":", 1)[1]
    match settings.llm_provider:
        case "anthropic":
            return AnthropicModel(
                name,
                provider=AnthropicProvider(api_key=key, base_url=settings.llm_base_url),
                # Cache the system prompt: the coach sends the same persona on every call.
                settings=AnthropicModelSettings(anthropic_cache_instructions=True),
            )
        case "gemini":
            return GoogleModel(
                name, provider=GoogleProvider(api_key=key, base_url=settings.llm_base_url)
            )
        case _:  # openai, ollama: Chat Completions, which OpenAI-compatible hosts speak
            return OpenAIChatModel(
                name, provider=OpenAIProvider(api_key=key, base_url=settings.llm_base_url)
            )


def cost_usd(model_id: str, usage: RunUsage | RequestUsage) -> float | None:
    """Price of `usage` in US dollars, or None when the model is local or has no known price.

    `model_id` is `provider:name` (as `model_id()` gives) or a bare name such as
    `claude-sonnet-5-5`.
    """
    provider, sep, name = model_id.partition(":")
    if not sep:
        provider, name = "", model_id
    if provider in UNPRICED_PREFIXES:
        return None
    try:
        price = calc_price(
            PriceUsage(
                input_tokens=usage.input_tokens,
                output_tokens=usage.output_tokens,
                cache_read_tokens=usage.cache_read_tokens,
                cache_write_tokens=usage.cache_write_tokens,
            ),
            name,
            provider_id=provider or None,
        )
    except LookupError:
        return None
    return float(price.total_price)


def to_llm_error(exc: BaseException) -> LlmError:
    """Network trouble (no connection, timeout) -> `network`; anything else the provider did."""
    if isinstance(exc, LlmError):
        return exc
    if isinstance(exc, ModelConnectionError | ModelRequestTimeout):
        return LlmError("network", f"Could not reach the model provider: {exc}")
    if isinstance(exc, ModelHTTPError):
        return LlmError("provider", f"The model provider answered {exc.status_code}: {exc}")
    if isinstance(exc, ModelAPIError):
        return LlmError("provider", f"The model provider failed: {exc}")
    if isinstance(exc, TimeoutError | ConnectionError):
        return LlmError("network", f"Could not reach the model provider: {exc}")
    return LlmError("provider", f"The model call failed: {exc}")
