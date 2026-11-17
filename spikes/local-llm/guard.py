"""Number guard and output checks for the local-LLM spike (vroom-9ki.17).

Every number in the model's prose must appear in the facts packet, written the same way. A failing number is
classified as:
  - format:     same value as a packet number, written differently (0.3 vs 0.30, 141 vs 141.0)
  - rounding:   a packet number rounded or truncated (0.141 -> 0.14)
  - calculated: the sum or difference of two packet numbers (the LLM did arithmetic, a non-goal)
  - invented:   none of the above
Distances in metres anywhere in the prose fail too (design §8: fixes never use metre distances).
"""

from __future__ import annotations

import itertools
import json
import re

NUM = re.compile(r"(?<![\w.])[-+]?\d+(?:[:.,]\d+)*(?![\w])")
METRES = re.compile(r"\b\d+(?:\.\d+)?\s?(?:m|metres?|meters?)\b", re.IGNORECASE)
PROSE_KEYS = ("summary", "encouragement")


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


NAME_KEYS = ("corner", "corner_id", "track", "car", "session")


def _strip_names(obj):
    """The packet without names and ids, whose digits ("Pouhon 2", "3 Nov 2026") are not facts."""
    if isinstance(obj, dict):
        return {k: _strip_names(v) for k, v in obj.items() if not (k in NAME_KEYS and isinstance(v, str))}
    if isinstance(obj, list):
        return [_strip_names(v) for v in obj]
    return obj


def names(packet: dict) -> list[str]:
    corners = packet["corners"] if "corners" in packet else [packet["corner"]]
    return sorted({c["corner"] for c in corners} | {packet["car"]}, key=len, reverse=True)


def packet_numbers(packet: dict) -> set[str]:
    return set(numbers(json.dumps(_strip_names(packet), ensure_ascii=False)))


def prose(result: dict) -> list[tuple[str, str]]:
    """(field, text) pairs the guard reads. corner names and ids are copied fields, not prose."""
    out = [(k, result.get(k) or "") for k in PROSE_KEYS]
    for i, f in enumerate(result.get("findings") or []):
        out += [(f"findings[{i}].what", f.get("what", "")), (f"findings[{i}].fix", f.get("fix", ""))]
        out += [(f"findings[{i}].evidence", e) for e in f.get("evidence") or []]
    focus = result.get("focus") or {}
    out += [("focus.instruction", focus.get("instruction", "")), ("focus.metric", focus.get("metric", ""))]
    return out


def classify(tok: str, pnums: set[str]) -> str:
    v = _value(tok)
    vals = [x for x in (_value(p) for p in pnums) if x is not None]
    if v is None:
        return "invented"
    if any(abs(v - p) < 1e-9 for p in vals):
        return "format"
    dec = len(_norm(tok).split(".")[1]) if "." in tok else 0
    step = 10 ** -dec
    if any(abs(v - p) <= step / 2 + 1e-9 or (0 <= p - v < step and p > 0) for p in vals):
        return "rounding"
    tol = step / 2 + 1e-9
    for a, b in itertools.combinations(vals, 2):
        if abs(abs(a - b) - v) <= tol or abs(a + b - v) <= tol:
            return "calculated"
    return "invented"


def check(result: dict, packet: dict) -> dict:
    """Guard verdict: {'ok', 'failures': [{field, number, reason}], 'contract': [...]}."""
    pnums = packet_numbers(packet)
    failures = []
    for field, text in prose(result):
        text = text.replace("\u00a0", " ").replace("\u202f", " ")
        for n in names(packet):
            text = text.replace(n, " ")
        for tok in numbers(text):
            if tok not in pnums:
                failures.append({"field": field, "number": tok, "reason": classify(tok, pnums)})
        for m in METRES.findall(text):
            failures.append({"field": field, "number": m, "reason": "metres"})
    return {"ok": not failures, "failures": failures, "contract": contract(result, packet)}


def contract(result: dict, packet: dict) -> list[str]:
    """Problems with the copied fields: one finding per packet corner, same id, kind and time_s."""
    corners = packet["corners"] if "corners" in packet else [packet["corner"]]
    found = result.get("findings") or []
    issues = []
    if len(found) != len(corners):
        issues.append(f"{len(found)} findings for {len(corners)} corners")
    for c, f in zip(corners, found):
        if f.get("corner_id") != c["corner_id"]:
            issues.append(f"corner_id {f.get('corner_id')} != {c['corner_id']}")
        if f.get("kind") != c["kind"]:
            issues.append(f"{c['corner_id']}: kind {f.get('kind')} != {c['kind']}")
        if abs(float(f.get("time_s", 1e9)) - float(c["time_s"])) > 5e-4:
            issues.append(f"{c['corner_id']}: time_s {f.get('time_s')} != {c['time_s']}")
    if packet["command"] == "analyze" and not result.get("focus"):
        issues.append("no focus")
    return issues


def retry_message(verdict: dict) -> str:
    bad = ", ".join(sorted({f["number"] for f in verdict["failures"]}))
    return (
        f"These numbers are not in the facts, or are metre distances: {bad}. Rewrite the whole JSON using only "
        "numbers that appear in the facts, written exactly as they appear there, and no distances in metres."
    )


SNAKE = re.compile(r"\b[a-z]+_[a-z_]+\b")


def lint(result: dict) -> list[str]:
    """Prose problems the number guard can't see: an empty or one-word what/fix, raw packet field names in prose."""
    issues = []
    for f in result.get("findings") or []:
        cid = f.get("corner_id", "?")
        if len((f.get("what") or "").split()) < 4:
            issues.append(f"{cid}: what too short")
        if f.get("kind") != "strength" and len((f.get("fix") or "").split()) < 4:
            issues.append(f"{cid}: fix too short")
    for field, text in prose(result):
        for m in SNAKE.findall(text):
            issues.append(f"{field}: field name '{m}'")
    return issues
