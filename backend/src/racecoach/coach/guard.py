"""Number guard and prose checks on the coach's answer (port of the spike's `guard.py`).

Every number in the prose must appear in the facts of the finding's own corner, written the same
way. A failing number is classified as `format` (same value, written differently), `rounding`,
`calculated` (a sum or difference of two facts: the LLM did arithmetic, a non-goal), or
`invented`. A distance in metres anywhere in the prose fails too: fixes never use metres.
"""

from __future__ import annotations

import itertools
import json
import re
from dataclasses import dataclass
from typing import Any

from racecoach.coach.schema import CoachOutput

NUM = re.compile(r"(?<![\w.])[-+]?\d+(?:[:.,]\d+)*(?!\d|st\b|nd\b|rd\b|th\b)")
METRES = re.compile(r"\b\d+(?:\.\d+)?\s?(?:m|metres?|meters?)\b", re.IGNORECASE)
SNAKE = re.compile(r"\b[a-z]+_[a-z_]+\b")
HEDGE = re.compile(
    r"\b(ambiguous|unclear|does not (?:establish|prove|show|identify|explain)"
    r"|do not (?:establish|prove|show|identify|explain)"
    r"|cannot (?:establish|tell|confirm)|can't (?:establish|tell|confirm)"
    r"|not (?:a )?(?:confirmed|proven)|only a clue|insufficient|not enough data"
    r"|without (?:pedal|speed|more) data)\b",
    re.IGNORECASE,
)
NAME_KEYS = ("corner", "corner_id", "track", "car", "session")


@dataclass(frozen=True)
class Failure:
    field: str
    number: str
    reason: str  # format | rounding | calculated | invented | metres


def _norm(tok: str) -> str:
    return tok.lstrip("+-").rstrip(".,")


def _value(tok: str) -> float | None:
    t = _norm(tok)
    if ":" in t:  # lap time m:ss.sss
        m, _, s = t.partition(":")
        try:
            return int(m) * 60 + float(s)
        except ValueError:
            return None
    try:
        return float(t.replace(",", ""))
    except ValueError:
        return None


def numbers(text: str) -> list[str]:
    return [_norm(t) for t in NUM.findall(text)]


def strip_names(obj: Any) -> Any:
    """The packet without names and ids, whose digits ("Pouhon 2", "3 Nov 2026") are not facts."""
    if isinstance(obj, dict):
        return {
            k: strip_names(v) for k, v in obj.items() if not (k in NAME_KEYS and isinstance(v, str))
        }
    if isinstance(obj, list):
        return [strip_names(v) for v in obj]
    return obj


def allowed_numbers(obj: Any) -> list[str]:
    """Every number the given facts show, as written (names left out), in order, once each."""
    found = numbers(json.dumps(strip_names(obj), ensure_ascii=False))
    return list(dict.fromkeys(found))


def prose(out: CoachOutput) -> list[tuple[str, str]]:
    """(field, text) pairs the guard reads; corner names and ids are copied fields, not prose."""
    pairs = [("summary", out.summary), ("encouragement", out.encouragement or "")]
    for i, f in enumerate(out.findings):
        pairs += [(f"findings[{i}].what", f.what), (f"findings[{i}].fix", f.fix)]
        pairs += [(f"findings[{i}].evidence", e) for e in f.evidence]
    if out.focus:
        pairs += [("focus.instruction", out.focus.instruction), ("focus.metric", out.focus.metric)]
    return pairs


def classify(tok: str, pnums: set[str]) -> str:
    v = _value(tok)
    vals = [x for x in (_value(p) for p in pnums) if x is not None]
    if v is None:
        return "invented"
    if any(abs(v - p) < 1e-9 for p in vals):
        return "format"
    dec = len(_norm(tok).split(".")[1]) if "." in tok else 0
    step = 10**-dec
    if any(abs(v - p) <= step / 2 + 1e-9 or (0 <= p - v < step and p > 0) for p in vals):
        return "rounding"
    tol = step / 2 + 1e-9
    for a, b in itertools.combinations(vals, 2):
        if abs(abs(a - b) - v) <= tol or abs(a + b - v) <= tol:
            return "calculated"
    return "invented"


def _scopes(out: CoachOutput, packet: dict[str, Any]) -> dict[str, set[str]]:
    """Field -> the numbers the finding's own corner allows. A finding naming an unknown corner
    (a structural problem reported separately) is checked against the whole packet."""
    allowed = {c["corner_id"]: set(c["allowed_numbers"]) for c in packet["corners"]}
    scopes: dict[str, set[str]] = {}
    for i, f in enumerate(out.findings):
        if f.corner_id in allowed:
            for key in ("what", "fix", "evidence"):
                scopes[f"findings[{i}].{key}"] = allowed[f.corner_id]
    return scopes


def check_numbers(out: CoachOutput, packet: dict[str, Any]) -> list[Failure]:
    """Numbers not in the facts and metre distances. Names are blanked before reading."""
    whole = {n for c in packet["corners"] for n in c["allowed_numbers"]} | set(
        packet.get("header_numbers", [])
    )
    scopes = _scopes(out, packet)
    names = sorted({c["corner"] for c in packet["corners"]} | {packet.get("car", "")}, key=len)
    failures: list[Failure] = []
    for field, text in prose(out):
        text = text.replace(" ", " ").replace(" ", " ")
        pnums = scopes.get(field, whole)
        for n in sorted(filter(None, names), key=len, reverse=True):
            text = text.replace(n, " ")
        for tok in numbers(text):
            if tok not in pnums:
                reason = classify(tok, pnums)
                if reason not in ("format", "rounding"):  # a rounded or reformatted fact is fine
                    failures.append(Failure(field, tok, reason))
        failures += [Failure(field, m, "metres") for m in METRES.findall(text)]
    return failures


def lint(out: CoachOutput) -> list[str]:
    """Prose problems the number guard can't see: a one-word what or fix, raw field names."""
    issues: list[str] = []
    for f in out.findings:
        if len(f.what.split()) < 4:
            issues.append(f"{f.corner_id}: what too short")
        if f.kind != "strength" and len(f.fix.split()) < 4:
            issues.append(f"{f.corner_id}: fix too short")
    for field, text in prose(out):
        issues += [f"{field}: field name '{m}'" for m in SNAKE.findall(text)]
    return issues


def hedges(out: CoachOutput) -> list[str]:
    """Hedging phrases ("does not establish", "ambiguous" ...) the blind rating flagged."""
    return [m.group(0) for _, text in prose(out) for m in HEDGE.finditer(text)]


def retry_message(failures: list[Failure]) -> str:
    bad = ", ".join(sorted({f.number for f in failures}))
    return (
        f"These numbers are not in the facts, or are metre distances: {bad}. Rewrite the whole "
        "JSON using only numbers that appear in the facts, written exactly as they appear "
        "there, and no distances in metres."
    )
