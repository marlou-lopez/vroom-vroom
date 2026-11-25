"""Run a coach command: packet -> Pydantic AI agent -> guarded answer -> stored result.

`build_packet` raises `CoachError` before any model is called. The agent's output validator
holds the rules: structural ones (one finding per packet corner, same ids and kinds in order,
the kind counts of the command, the focus) and prose ones (number guard, metre distances, a
one-word `what`/`fix`, field names, hedging). A violation sends one retry with the problem
named. After the retry, prose problems are kept as `warnings` on the result; a structural
problem, or an answer that is not valid JSON twice, is `CoachError("invalid_output")`. Provider
trouble is an `LlmError` (and is logged). Every call is logged with its cost.
"""

from __future__ import annotations

import json
import uuid
from collections import Counter
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from pydantic_ai import Agent, ModelRetry, RunContext
from pydantic_ai.exceptions import UnexpectedModelBehavior
from pydantic_ai.models import Model
from pydantic_ai.output import NativeOutput

from racecoach.coach import guard
from racecoach.coach.errors import CoachError
from racecoach.coach.packet import Packet, build_packet, load_profile
from racecoach.coach.schema import (
    CoachOutput,
    CoachResult,
    Command,
    Finding,
    Focus,
)
from racecoach.llm import LlmError, Tier, cost_usd, make_model, model_id, to_llm_error
from racecoach.settings import Settings
from racecoach.store import AppStore

PROMPTS = Path(__file__).parent / "prompts"
MAX_ISSUES = 3
MAX_MINOR = 1
MAX_STRENGTH = 1
MAX_INCONSISTENT = 3


def system_prompt(command: Command, coach_name: str) -> str:
    persona = (PROMPTS / "persona.md").read_text().replace("{coach_name}", coach_name)
    return persona + "\n" + (PROMPTS / f"{command}.md").read_text()


def structure_problems(command: Command, out: CoachOutput, packet: Packet) -> list[str]:
    """Rules the answer must meet as a whole: one finding per packet corner (same id, kind and
    order), the kind counts of the command and the focus."""
    problems: list[str] = []
    want = packet.corners
    if len(out.findings) != len(want):
        problems.append(f"{len(out.findings)} findings for {len(want)} corners")
    for c, f in zip(want, out.findings, strict=False):
        if f.corner_id != c.corner_id:
            problems.append(f"corner_id {f.corner_id} should be {c.corner_id}")
        elif f.kind != c.kind:
            problems.append(f"{c.corner_id}: kind {f.kind} should be {c.kind}")
    kinds = Counter(f.kind for f in out.findings)
    if command == "analyze":
        if (
            kinds["issue"] > MAX_ISSUES
            or kinds["minor"] > MAX_MINOR
            or kinds["strength"] > MAX_STRENGTH
        ):
            problems.append("analyze takes at most 3 issues, 1 minor and 1 strength")
        if kinds["inconsistent"]:
            problems.append("analyze has no inconsistent findings")
        first = next((f for f in out.findings if f.kind == "issue"), None)
        if first is not None and (out.focus is None or out.focus.corner_id != first.corner_id):
            problems.append(f"focus must be the first issue's corner, {first.corner_id}")
    elif command == "average":
        if set(kinds) - {"inconsistent"} or kinds["inconsistent"] > MAX_INCONSISTENT:
            problems.append("average takes at most 3 inconsistent findings")
    elif len(out.findings) != 1:
        problems.append("corner takes exactly 1 finding")
    return problems


_WHY = {"metres": "a distance in metres"}


def prose_problems(out: CoachOutput, packet: Packet) -> list[str]:
    msgs = [
        f"{f.field}: {f.number} is {_WHY.get(f.reason, 'not in the facts')} ({f.reason})"
        for f in guard.check_numbers(out, packet.guard_view)
    ]
    msgs += guard.lint(out)
    msgs += [f"hedging: '{h}'" for h in guard.hedges(out)]
    return msgs


def normalise(command: Command, out: CoachOutput, packet: Packet) -> CoachOutput:
    """Copy the corner names and times from the packet (they are facts, not prose) and drop a
    focus or encouragement where the command has none."""
    for c, f in zip(packet.corners, out.findings, strict=False):
        f.corner, f.time_s = c.name, c.time_s
    if command != "analyze" or not any(f.kind == "issue" for f in out.findings):
        out.focus = None
    if command == "average":
        out.encouragement = None
    return out


def _agent(
    model: Model, command: Command, packet: Packet, settings: Settings
) -> tuple[Agent[object, CoachOutput], list[str]]:
    warnings: list[str] = []
    agent: Agent[object, CoachOutput] = Agent(
        model,
        output_type=NativeOutput(CoachOutput),
        instructions=system_prompt(command, settings.coach_name),
        retries={"output": 1},
    )

    @agent.output_validator
    def _rules(ctx: RunContext[object], out: CoachOutput) -> CoachOutput:
        warnings.clear()
        hard = structure_problems(command, out, packet)
        soft = prose_problems(out, packet)
        if hard or soft:
            if ctx.last_attempt and not hard:
                warnings.extend(soft)
            else:
                bad = guard.check_numbers(out, packet.guard_view)
                hint = " " + guard.retry_message(bad) if bad else ""
                raise ModelRetry(
                    "Fix these problems and answer again: " + "; ".join(hard + soft) + "." + hint
                )
        return normalise(command, out, packet)

    return agent, warnings


def run_coach(
    store: AppStore,
    settings: Settings,
    command: Command,
    lap_id: str,
    ref_lap_id: str | None = None,
    corner_id: str | None = None,
    *,
    model: Model | None = None,
) -> CoachResult:
    """Build the packet, ask the model, store the result. Raises `CoachError` (nothing coached
    or an unusable answer) or `LlmError` (no key, network, provider)."""
    packet = build_packet(
        store, command, lap_id, ref_lap_id, corner_id,
        tracks_dir=settings.tracks_dir, profile=load_profile(settings.profile_path),
    )  # fmt: skip
    tier: Tier = "fast" if command == "average" else "strong"
    mid = model_id(settings, tier)
    purpose = f"coach:{command}"

    def log_call(**kw: Any) -> None:
        store.log_llm_call(
            purpose=purpose, provider=settings.llm_provider, model=mid.split(":", 1)[1],
            lap_id=lap_id, **kw,
        )  # fmt: skip

    try:
        llm = model or make_model(settings, tier)
    except LlmError as e:
        log_call(ok=False, detail=e.message)
        raise
    agent, warnings = _agent(llm, command, packet, settings)
    prompt = json.dumps(packet.data, ensure_ascii=False, indent=1)
    try:
        run = agent.run_sync(prompt)
    except UnexpectedModelBehavior as e:
        log_call(ok=False, detail=f"invalid output: {e}")
        raise CoachError(
            "invalid_output", "The coach's answer could not be used. Try again."
        ) from e
    except Exception as e:
        err = to_llm_error(e)
        log_call(ok=False, detail=f"{err.code}: {err.message}")
        raise err from e

    usage = run.usage
    cost = cost_usd(mid, usage)
    log_call(
        input_tokens=usage.input_tokens, output_tokens=usage.output_tokens,
        cost_usd=cost or 0.0, ok=True, detail="; ".join(warnings) or None,
    )  # fmt: skip
    out = run.output
    rid = uuid.uuid4().hex
    result = CoachResult(
        id=rid, command=command, lap_id=lap_id, ref_lap_id=packet.ref_lap_id or ref_lap_id,
        summary=out.summary,
        findings=[Finding(**f.model_dump(), id=f"{rid}-{i}") for i, f in enumerate(out.findings)],
        focus=Focus(**out.focus.model_dump()) if out.focus else None,
        encouragement=out.encouragement, stats=packet.stats, warnings=list(warnings),
        cost_usd=cost, created_at=datetime.now(UTC).isoformat(),
    )  # fmt: skip
    store.save_coach_result(result)
    if result.focus is not None:
        for old in store.focus_items(packet.track_id, packet.car_id, "open"):
            if old["session_id"] == packet.session_id:
                store.set_focus_status(old["id"], "superseded")
        store.add_focus_item(
            packet.track_id, packet.car_id, result.focus.instruction,
            corner_id=result.focus.corner_id, metric=result.focus.metric,
            baseline_s=packet.focus_baselines.get(result.focus.corner_id),
            session_id=packet.session_id,
        )  # fmt: skip
    return result
