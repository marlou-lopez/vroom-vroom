"""Results table and blind rating sheet from results/runs.jsonl (vroom-9ki.17).

  python3 -I summarize.py table            # markdown table per model and packet
  python3 -I summarize.py blind [--per 2]  # blind/sheet.md (no model names) and blind/key.json (do not open before rating)
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import statistics
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import guard  # noqa: E402


def rows(path: Path) -> list[dict]:
    """The logged calls, with the guard re-run on every stored output (so a guard fix needs no new model calls)."""
    out = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    packets = {}
    for r in out:
        pset = r.get("packets", "packets")
        packet = packets.setdefault((pset, r["packet"]), json.loads((HERE / pset / f"{r['packet']}.json").read_text()))
        for att in (r["first"], r["retry"]):
            if att and att.get("schema_ok"):
                att["guard"] = guard.check(att["result"], packet)
        if r["retry"] and r["first"].get("schema_ok") and r["first"]["guard"]["ok"]:
            r["retry"] = None  # the retry only ran because of a guard bug since fixed
    return out


def label(r: dict) -> str:
    """Model / prompt, plus the packet set when it isn't v1."""
    pset = r.get("packets", "packets")
    return f"{r['model']} / {r.get('prompt', 'prompt.md')}" + ("" if pset == "packets" else f" / {pset}")


def ok(x: dict | None) -> bool:
    return bool(x and x.get("schema_ok") and x["guard"]["ok"])


def med(xs: list[float]) -> str:
    xs = [x for x in xs if x is not None]
    return f"{statistics.median(xs):.1f}" if xs else "–"


def table(rs: list[dict]) -> str:
    groups = collections.defaultdict(list)
    for r in rs:
        groups[(label(r), r["packet"])].append(r)
    cold = {}
    for r in rs:  # the first call of each model loads it; leave it out of the timing medians
        cold.setdefault(label(r), id(r))
    out = ["| Model | Packet | n | Schema valid | Guard pass, 1st try | after 1 retry | Contract kept | Prose clean | Hedge-free | Failure reasons | TTFT s (median, warm) | First JSON token s | Total s (median, warm) | Output tokens | Cost $ |",
           "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for (model, packet), g in sorted(groups.items()):
        n = len(g)
        schema = sum(1 for r in g if r["first"].get("schema_ok"))
        first = sum(1 for r in g if ok(r["first"]))
        after = sum(1 for r in g if ok(r["first"]) or ok(r["retry"]))
        contract = sum(1 for r in g if r["first"].get("schema_ok") and not r["first"]["guard"]["contract"])
        clean = sum(1 for r in g if r["first"].get("schema_ok") and not guard.lint(r["first"]["result"]))
        hedge_free = sum(1 for r in g if r["first"].get("schema_ok") and not guard.hedges(r["first"]["result"]))
        reasons = collections.Counter()
        for r in g:
            for att in (r["first"], r["retry"]):
                if att and att.get("schema_ok"):
                    reasons.update({f["reason"] for f in att["guard"]["failures"]})
                elif att and "error" in att:
                    reasons["error"] += 1
                elif att:
                    reasons["schema"] += 1
        warm = [r for r in g if id(r) != cold[model]]
        cost = [r["first"].get("cost_usd") or 0 for r in g] + [(r["retry"] or {}).get("cost_usd") or 0 for r in g]
        out.append(
            f"| {model} | {packet} | {n} | {schema}/{n} | {first}/{n} | {after}/{n} | {contract}/{n} | {clean}/{n} | {hedge_free}/{n} | "
            f"{', '.join(f'{k} {v}' for k, v in reasons.most_common()) or '–'} | "
            f"{med([r['first'].get('ttft_s') for r in warm])} | {med([r['first'].get('ttft_text_s') for r in warm])} | {med([r['first'].get('total_s') for r in warm])} | "
            f"{med([r['first'].get('output_tokens') for r in g])} | {sum(cost):.4f} |"
        )
    return "\n".join(out)


def blind(rs: list[dict], per: int, seed: int) -> None:
    rng = random.Random(seed)
    by = collections.defaultdict(list)
    for r in rs:
        best = r["retry"] if r["retry"] and r["retry"].get("schema_ok") else r["first"]
        if best.get("schema_ok"):
            by[(r["packet"], label(r))].append(best["result"])
    items = []
    for (packet, model), results in by.items():
        for res in rng.sample(results, min(per, len(results))):
            items.append({"packet": packet, "model": model, "result": res})
    rng.shuffle(items)
    items.sort(key=lambda x: x["packet"])  # rate packet by packet; order inside a packet stays shuffled
    key, lines = {}, ["# Blind rating sheet (vroom-9ki.17)", "",
                       "Rate each `what` / `fix` 1–5: does it read like a race engineer? (5 = yes, I'd act on it).",
                       "Write the score after **Score:**. Don't open `key.json` until every score is in.", ""]
    for i, it in enumerate(items, 1):
        code = f"S{i:02d}"
        key[code] = {"model": it["model"], "packet": it["packet"]}
        res = it["result"]
        lines += [f"## {code} · {it['packet']}", "", f"> {res['summary']}", ""]
        for f in res["findings"]:
            lines += [f"- **{f['corner']}** ({f['kind']}, {f['time_s']} s)", f"  - what: {f['what']}", f"  - fix: {f['fix']}"]
        if res.get("focus"):
            lines.append(f"- focus: {res['focus']['instruction']} (metric: {res['focus']['metric']})")
        if res.get("encouragement"):
            lines.append(f"- encouragement: {res['encouragement']}")
        lines += ["", "**Score:** ", ""]
    d = HERE / "blind"
    d.mkdir(exist_ok=True)
    (d / "sheet.md").write_text("\n".join(lines))
    (d / "key.json").write_text(json.dumps(key, indent=1) + "\n")
    print(f"{len(items)} samples -> blind/sheet.md")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["table", "blind"])
    ap.add_argument("--runs", default=str(HERE / "results" / "runs.jsonl"))
    ap.add_argument("--per", type=int, default=2, help="samples per model and packet in the blind sheet")
    ap.add_argument("--seed", type=int, default=917)
    a = ap.parse_args()
    rs = rows(Path(a.runs))
    if a.what == "table":
        print(table(rs))
    else:
        blind(rs, a.per, a.seed)


if __name__ == "__main__":
    main()
