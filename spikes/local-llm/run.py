"""Runs every facts packet N times per model and logs each call (vroom-9ki.17). Not a test: it calls real models.

  uv run --with openai --with anthropic --with jsonschema python -I run.py \
      --model ollama:gpt-oss-20b-nommap --model anthropic:claude-sonnet-5-5 --runs 5

ollama:<tag> talks to Ollama's OpenAI-compatible endpoint (OLLAMA_BASE_URL, default http://127.0.0.1:11434/v1;
from WSL use the Windows NAT gateway, e.g. http://172.24.16.1:11434/v1). anthropic:<id> needs ANTHROPIC_API_KEY
(or an `ant auth login` profile). Results append to results/runs.jsonl, one line per call.
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

PROMPT = os.environ.get("SPIKE_PROMPT", "prompt.md")
SYSTEM = (HERE / PROMPT).read_text()


def user_message(packet: dict) -> str:
    return f"Command: {packet['command']}\n\nFacts:\n```json\n{json.dumps(packet, indent=1, ensure_ascii=False)}\n```"


def call_ollama(model: str, messages: list[dict]) -> dict:
    from openai import OpenAI

    client = OpenAI(base_url=os.environ.get("OLLAMA_BASE_URL", "http://127.0.0.1:11434/v1"), api_key="ollama")
    t0 = time.perf_counter()
    first_any = first_text = None
    text, usage = [], None
    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "system", "content": SYSTEM}, *messages],
        stream=True,
        stream_options={"include_usage": True},
        response_format={"type": "json_schema", "json_schema": {"name": "coach_result", "schema": SCHEMA, "strict": True}},
        temperature=float(os.environ.get("SPIKE_TEMPERATURE", "0.7")),
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
    return {
        "text": "".join(text), "ttft_s": first_any, "ttft_text_s": first_text, "total_s": time.perf_counter() - t0,
        "input_tokens": usage.prompt_tokens if usage else None, "output_tokens": usage.completion_tokens if usage else None,
        "cost_usd": None,
    }


def call_anthropic(model: str, messages: list[dict]) -> dict:
    import anthropic

    client = anthropic.Anthropic()
    t0 = time.perf_counter()
    first_any = first_text = None
    with client.messages.stream(
        model=model,
        max_tokens=16000,
        system=SYSTEM,
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
    pin, pout = PRICES.get(model, (None, None))
    u = msg.usage
    cost = (u.input_tokens * pin + u.output_tokens * pout) / 1e6 if pin is not None else None
    return {
        "text": text, "ttft_s": first_any, "ttft_text_s": first_text, "total_s": time.perf_counter() - t0,
        "input_tokens": u.input_tokens, "output_tokens": u.output_tokens, "cost_usd": cost, "stop_reason": msg.stop_reason,
    }


def attempt(spec: str, messages: list[dict], packet: dict) -> dict:
    provider, _, model = spec.partition(":")
    fn = {"ollama": call_ollama, "anthropic": call_anthropic}[provider]
    try:
        out = fn(model, messages)
    except Exception as e:  # noqa: BLE001 - a spike logs every failure and goes on
        return {"error": f"{type(e).__name__}: {e}"}
    try:
        result = json.loads(out["text"])
        jsonschema.validate(result, SCHEMA)
        out["schema_ok"] = True
    except (json.JSONDecodeError, jsonschema.ValidationError) as e:
        out["schema_ok"] = False
        out["schema_error"] = str(e)[:300]
        return out
    out["result"] = result
    out["guard"] = guard.check(result, packet)
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", action="append", required=True, help="ollama:<tag> or anthropic:<model id>")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--packet", action="append", help="packet name (default: all in packets/)")
    ap.add_argument("--out", default=str(HERE / "results" / "runs.jsonl"))
    a = ap.parse_args()
    names = a.packet or sorted(p.stem for p in (HERE / "packets").glob("*.json"))
    Path(a.out).parent.mkdir(exist_ok=True)
    with open(a.out, "a") as log:
        for spec in a.model:
            for name in names:
                packet = json.loads((HERE / "packets" / f"{name}.json").read_text())
                for run in range(a.runs):
                    messages = [{"role": "user", "content": user_message(packet)}]
                    first = attempt(spec, messages, packet)
                    retry = None
                    if first.get("guard") and not first["guard"]["ok"]:
                        messages += [{"role": "assistant", "content": first["text"]},
                                     {"role": "user", "content": guard.retry_message(first["guard"])}]
                        retry = attempt(spec, messages, packet)
                    row = {"at": dt.datetime.now().isoformat(timespec="seconds"), "model": spec, "prompt": PROMPT, "packet": name,
                           "run": run, "first": first, "retry": retry}
                    log.write(json.dumps(row, ensure_ascii=False) + "\n")
                    log.flush()
                    g = lambda x: "-" if not x else ("ERR" if "error" in x else ("schema!" if not x.get("schema_ok") else ("ok" if x["guard"]["ok"] else "fail")))  # noqa: E731
                    print(f"{spec} {name} #{run}: first {g(first)} retry {g(retry)} total {first.get('total_s', 0):.1f}s", flush=True)


if __name__ == "__main__":
    main()
