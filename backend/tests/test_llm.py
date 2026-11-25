from __future__ import annotations

import os
from pathlib import Path

import pytest
from pydantic_ai import Agent, models
from pydantic_ai.exceptions import ModelAPIError, ModelHTTPError
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.function import FunctionModel
from pydantic_ai.models.google import GoogleModel
from pydantic_ai.models.openai import OpenAIChatModel
from pydantic_ai.models.test import TestModel
from pydantic_ai.usage import RunUsage

from racecoach.llm import LlmError, cost_usd, make_model, model_id, to_llm_error
from racecoach.settings import Settings

models.ALLOW_MODEL_REQUESTS = False


@pytest.fixture(autouse=True)
def _clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    for k in list(os.environ):
        if k.startswith("RACECOACH_") or k.endswith("_API_KEY"):
            monkeypatch.delenv(k)
    monkeypatch.chdir(tmp_path)


def test_missing_key(monkeypatch: pytest.MonkeyPatch):
    for provider in ("openai", "anthropic"):
        monkeypatch.setenv("RACECOACH_LLM_PROVIDER", provider)
        with pytest.raises(LlmError) as e:
            make_model(Settings(), "strong")
        assert e.value.code == "missing_api_key"


def test_key_from_provider_variable(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("OPENAI_API_KEY", "k")
    assert isinstance(make_model(Settings(), "fast"), OpenAIChatModel)


def test_provider_prefix_mapping(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RACECOACH_LLM_STRONG", "s")
    monkeypatch.setenv("RACECOACH_LLM_FAST", "f")
    expected = {
        "openai": ("openai:", OpenAIChatModel),
        "anthropic": ("anthropic:", AnthropicModel),
        "gemini": ("google-gla:", GoogleModel),
        "ollama": ("ollama:", OpenAIChatModel),
    }
    for provider, (prefix, cls) in expected.items():
        monkeypatch.setenv("RACECOACH_LLM_PROVIDER", provider)
        monkeypatch.setenv(f"RACECOACH_{provider.upper()}_API_KEY", "k")
        s = Settings()
        assert model_id(s, "strong") == f"{prefix}s"
        assert model_id(s, "fast") == f"{prefix}f"
        assert isinstance(make_model(s, "strong"), cls)


def test_default_ids_and_tiers():
    s = Settings()
    assert model_id(s, "strong") == "openai:gpt-6.1-terra"
    assert model_id(s, "fast") == "openai:gpt-6-luna"


def test_openai_base_url_is_unpriced(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RACECOACH_LLM_BASE_URL", "https://openrouter.example/v1")
    monkeypatch.setenv("RACECOACH_OPENAI_API_KEY", "k")
    s = Settings()
    assert model_id(s, "strong").startswith("openai-compat:")
    assert make_model(s, "strong").base_url == "https://openrouter.example/v1/"
    assert cost_usd(model_id(s, "strong"), RunUsage(input_tokens=10, output_tokens=10)) is None


def test_ollama_needs_no_key_and_defaults_base_url(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RACECOACH_LLM_PROVIDER", "ollama")
    monkeypatch.setenv("RACECOACH_LLM_STRONG", "qwen")
    monkeypatch.setenv("RACECOACH_LLM_FAST", "qwen")
    model = make_model(Settings(), "strong")
    assert model.base_url == "http://127.0.0.1:11434/v1/"
    assert cost_usd("ollama:qwen", RunUsage(input_tokens=1000, output_tokens=1000)) is None


def test_anthropic_caches_the_system_prompt(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setenv("RACECOACH_LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "k")
    model = make_model(Settings(), "strong")
    assert (model.settings or {}).get("anthropic_cache_instructions") is True


def test_cost_known_and_unknown():
    usage = RunUsage(input_tokens=1000, output_tokens=1000)
    assert (cost_usd("claude-sonnet-5-5", usage) or 0) > 0
    assert (cost_usd("anthropic:claude-sonnet-5-5", usage) or 0) > 0
    assert cost_usd("openai:gpt-6.1-terra", usage) == pytest.approx(0.006)
    assert cost_usd("no-such-model", usage) is None
    assert cost_usd("openai:no-such-model", usage) is None


def test_error_mapping():
    from pydantic_ai.exceptions import ModelConnectionError, ModelTimeoutError

    assert to_llm_error(ModelConnectionError("m", "down")).code == "network"
    assert to_llm_error(ModelTimeoutError("m", "slow")).code == "network"
    assert to_llm_error(TimeoutError("t")).code == "network"
    http = to_llm_error(ModelHTTPError(500, "m", "boom"))
    assert http.code == "provider" and "500" in http.message
    assert to_llm_error(ModelAPIError("m", "x")).code == "provider"
    assert to_llm_error(ValueError("x")).code == "provider"
    err = LlmError("missing_api_key", "no key")
    assert to_llm_error(err) is err


def test_agent_run_with_test_models_prices_usage():
    agent = Agent(TestModel(custom_output_text="hello"))
    result = agent.run_sync("hi")
    assert result.output == "hello"

    def fn(messages, info):
        from pydantic_ai.messages import ModelResponse, TextPart

        return ModelResponse(parts=[TextPart("ok")])

    assert Agent(FunctionModel(fn)).run_sync("hi").output == "ok"
    assert cost_usd("claude-sonnet-5-5", result.usage) is not None
