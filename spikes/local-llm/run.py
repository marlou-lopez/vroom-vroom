"""Runs every facts packet N times per model and logs each call (vroom-9ki.17). Not a test: it calls real models.

  # the models in models.json (those whose key is set; the rest are skipped, not logged as errors)
  uv run --with openai --with anthropic --with jsonschema python -I run.py --matrix models.json \
      --prompt prompt-v3.md --packets packets-v2 --runs 5 --round 2026-11-17-r2
  # or one model ad hoc
  uv run ... run.py --model ollama:gpt-oss-20b-nommap --prompt prompt-v3.md --packets packets-v2

Providers (all but anthropic go through the OpenAI SDK's chat completions with a JSON-schema response_format):
  ollama     Ollama's OpenAI-compatible endpoint: OLLAMA_BASE_URL (default http://127.0.0.1:11434/v1; from WSL use the
             Windows NAT gateway, e.g. http://172.24.16.1:11434/v1). No key, no cost.
  openai     OpenAI, or any OpenAI-compatible host (OpenRouter, Groq, Gemini's OpenAI endpoint ...) through the entry's
             base_url and key_env.
  anthropic  Anthropic Messages API, ANTHROPIC_API_KEY.
Ad hoc --model ids take their price from SPIKE_PRICE="<input>,<output>" ($ per 1M tokens), or built in for Claude.
SPIKE_PROMPT and SPIKE_TEMPERATURE still work as before. Results append to results/runs.jsonl, one line per call.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
import time
from pathlib import Path

import jsonschema

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import guard  # noqa: E402

PRICES = {"claude-sonnet-5-5": (2.0, 10.0), "claude-haiku-5-5": (0.10, 0.50)}  # $ per 1M input / output tokens

NULLABLE_STR = {"anyOf": [{"type": "string"}, {"type": "null"}]}
# The part of CoachResult (frontend/src/api/types.ts) the LLM writes; ids, reviewed, stats, cost and dates come from code.
SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["summary", "findings", "focus", "encouragement"],
    "properties": {
        "summary": {"type": "string"},
        "findings": {
            "type": "array",
            "items": {
                "type": "object",
                "additionalProperties": False,
                "required": ["corner_id", "corner", "kind", "time_s", "what", "fix", "cue_type", "evidence"],
                "properties": {
                    "corner_id": {"type": "string"},
                    "corner": {"type": "string"},
                    "kind": {"type": "string", "enum": ["issue", "minor", "strength", "inconsistent"]},
                    "time_s": {"type": "number"},
                    "what": {"type": "string"},
                    "fix": {"type": "string"},
                    "cue_type": {"type": "string", "enum": ["landmark", "feel", "own_lap", "none"]},
                    "evidence": {"type": "array", "items": {"type": "string"}},
                },
            },
        },
        "focus": {
            "anyOf": [
                {
                    "type": "object",
                    "additionalProperties": False,
                    "required": ["corner_id", "instruction", "metric"],
                    "properties": {"corner_id": {"type": "string"}, "instruction": {"type": "string"}, "metric": {"type": "string"}},
                },
                {"type": "null"},
            ]
        },
        "encouragement": NULLABLE_STR,
    },
}


def user_message(packet: dict) -> str:
    return f"Command: {packet['command']}\n\nFacts:\n```json\n{json.dumps(packet, indent=1, ensure_ascii=False)}\n```"


def entry_for(spec: str) -> dict:
    """A model config from an ad hoc `provider:model` id (see models.json for the fields)."""
    provider, _, model = spec.partition(":")
    env = os.environ.get("SPIKE_PRICE")
    price = PRICES.get(model) or (tuple(float(x) for x in env.split(",")) if env else None)
    key_env = {"openai": "OPENAI_API_KEY", "anthropic": "ANTHROPIC_API_KEY"}.get(provider)
    return {"id": spec, "provider": provider, "model": model, "price": price, "key_env": key_env,
            "base_url": os.environ.get("OPENAI_BASE_URL") if provider == "openai" else None}


def missing_key(e: dict) -> str | None:
    k = e.get("key_env")
    return k if k and not os.environ.get(k) else None


def call(e: dict, system: str, messages: list[dict]) -> dict:
    if e["provider"] == "anthropic":
        return call_anthropic(e, system, messages)
    if e["provider"] == "ollama":
        base = e.get("base_url") or os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1")
        temp = float(os.environ.get("SPIKE_TEMPERATURE", e.get("temperature", 0.7)))
        return call_openai_compatible(e, system, messages, base_url=base, api_key="ollama", temperature=temp)
    if e["provider"] == "openai":
        # Reasoning models reject a non-default temperature, so send one only when asked for.
        t = os.environ.get("SPIKE_TEMPERATURE", e.get("temperature"))
        return call_openai_compatible(e, system, messages, base_url=e.get("base_url"),
                                      api_key=os.environ.get(e.get("key_env") or "OPENAI_API_KEY"),
                                      temperature=float(t) if t is not None else None)
    raise ValueError(f"unknown provider {e['provider']}")


def cost(e: dict, tokens_in: int | None, tokens_out: int | None) -> float | None:
    p = e.get("price")
    if not p or tokens_in is None or tokens_out is None:
        return None
    return (tokens_in * p[0] + tokens_out * p[1]) / 1e6


def call_openai_compatible(e: dict, system: str, messages: list[dict], *, base_url: str | None, api_key: str | None,
                           temperature: float | None) -> dict:
    from openai import OpenAI

    client = OpenAI(base_url=base_url, api_key=api_key)
    extra = {"temperature": temperature} if temperature is not None else {}
    if e.get("json_mode") == "json_object":
        # Hosts without JSON-schema output (DeepSeek's chat API): plain JSON mode, the schema goes in the prompt and
        # jsonschema checks the answer afterwards, so the schema-valid rate is measured, not guaranteed.
        fmt = {"type": "json_object"}
        system = f"{system}\n\n# JSON schema of your answer\n\n```json\n{json.dumps(SCHEMA)}\n```\n"
    else:
        fmt = {"type": "json_schema", "json_schema": {"name": "coach_result", "schema": SCHEMA, "strict": True}}
    t0 = time.perf_counter()
    first_any = first_text = None
    text, usage = [], None
    stream = client.chat.completions.create(
        model=e["model"],
        messages=[{"role": "system", "content": system}, *messages],
        stream=True,
        stream_options={"include_usage": True},
        response_format=fmt,
        **extra,
    )
    for chunk in stream:
        if chunk.usage:
            usage = chunk.usage
        if not chunk.choices:
            continue
        d = chunk.choices[0].delta
        reasoning = getattr(d, "reasoning", None) or getattr(d, "reasoning_content", None)
        if (reasoning or d.content) and first_any is None:
            first_any = time.perf_counter() - t0
        if d.content:
            if first_text is None:
                first_text = time.perf_counter() - t0
            text.append(d.content)
    tin = usage.prompt_tokens if usage else None
    tout = usage.completion_tokens if usage else None
    return {
        "text": "".join(text), "ttft_s": first_any, "ttft_text_s": first_text, "total_s": time.perf_counter() - t0,
        "input_tokens": tin, "output_tokens": tout, "cost_usd": cost(e, tin, tout),
    }


def call_anthropic(e: dict, system: str, messages: list[dict]) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    t0 = time.perf_counter()
    first_any = first_text = None
    with client.messages.stream(
        model=e["model"],
        max_tokens=16000,
        system=system,
        messages=messages,
        output_config={"format": {"type": "json_schema", "schema": SCHEMA}},
    ) as stream:
        for event in stream:
            if first_any is None and event.type in ("content_block_start", "content_block_delta"):
                first_any = time.perf_counter() - t0
            if first_text is None and event.type == "content_block_delta" and getattr(event.delta, "type", "") == "text_delta":
                first_text = time.perf_counter() - t0
        msg = stream.get_final_message()
    text = "".join(b.text for b in msg.content if b.type == "text")
    u = msg.usage
    return {
        "text": text, "ttft_s": first_any, "ttft_text_s": first_text, "total_s": time.perf_counter() - t0,
        "input_tokens": u.input_tokens, "output_tokens": u.output_tokens, "cost_usd": cost(e, u.input_tokens, u.output_tokens),
        "stop_reason": msg.stop_reason,
    }


def attempt(e: dict, system: str, messages: list[dict], packet: dict) -> dict:
    try:
        out = call(e, system, messages)
    except Exception as ex:  # noqa: BLE001 - a spike logs every failure and goes on
        return {"error": f"{type(ex).__name__}: {ex}"}
    try:
        result = json.loads(out["text"])
        jsonschema.validate(result, SCHEMA)
        out["schema_ok"] = True
    except (json.JSONDecodeError, jsonschema.ValidationError) as ex:
        out["schema_ok"] = False
        out["schema_error"] = str(ex)[:300]
        return out
    out["result"] = result
    out["guard"] = guard.check(result, packet)
    return out


def models(a: argparse.Namespace) -> list[dict]:
    out = [entry_for(spec) for spec in a.model or []]
    if a.matrix:
        entries = json.loads((HERE / a.matrix).read_text())["models"]
        wanted = set(a.select.split(",")) if a.select else None
        for e in entries:
            if (wanted and e["id"] in wanted) or (not wanted and e.get("enabled", True)):
                out.append(e)
        if wanted and (unknown := wanted - {e["id"] for e in entries}):
            raise SystemExit(f"not in {a.matrix}: {', '.join(sorted(unknown))}")
    if not out:
        raise SystemExit("give --model and/or --matrix")
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", help="ad hoc provider:model, e.g. ollama:gpt-oss-20b-nommap")
    ap.add_argument("--matrix", help="model list, e.g. models.json (its enabled entries, or --select)")
    ap.add_argument("--select", help="comma-separated ids from the matrix, enabled or not")
    ap.add_argument("--prompt", default=os.environ.get("SPIKE_PROMPT", "prompt.md"), help="system prompt file")
    ap.add_argument("--packets", default="packets", help="packet set directory, e.g. packets-v2 or packets-v2-monza")
    ap.add_argument("--packet", action="append", help="packet name (default: all in the packet set)")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--round", default=dt.date.today().isoformat(), help="tag for this batch of runs")
    ap.add_argument("--out", default=str(HERE / "results" / "runs.jsonl"))
    a = ap.parse_args()
    system = (HERE / a.prompt).read_text()
    names = a.packet or sorted(p.stem for p in (HERE / a.packets).glob("*.json"))
    todo = []
    for e in models(a):
        if k := missing_key(e):
            print(f"skip {e['id']}: {k} is not set", flush=True)
        else:
            todo.append(e)
    Path(a.out).parent.mkdir(exist_ok=True)
    with open(a.out, "a") as log:
        for e in todo:
            for name in names:
                packet = json.loads((HERE / a.packets / f"{name}.json").read_text())
                for run in range(a.runs):
                    messages = [{"role": "user", "content": user_message(packet)}]
                    first = attempt(e, system, messages, packet)
                    retry = None
                    if first.get("guard") and not first["guard"]["ok"]:
                        messages += [{"role": "assistant", "content": first["text"]},
                                     {"role": "user", "content": guard.retry_message(first["guard"])}]
                        retry = attempt(e, system, messages, packet)
                    row = {"at": dt.datetime.now().isoformat(timespec="seconds"), "round": a.round, "model": e["id"],
                           "prompt": a.prompt, "packets": a.packets, "packet": name, "run": run, "first": first, "retry": retry}
                    log.write(json.dumps(row, ensure_ascii=False) + "\n")
                    log.flush()
                    g = lambda x: "-" if not x else ("ERR" if "error" in x else ("schema!" if not x.get("schema_ok") else ("ok" if x["guard"]["ok"] else "fail")))  # noqa: E731
                    print(f"{e['id']} {name} #{run}: first {g(first)} retry {g(retry)} total {first.get('total_s', 0):.1f}s", flush=True)


if __name__ == "__main__":
    main()
