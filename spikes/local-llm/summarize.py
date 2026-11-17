"""Results table, blind rating sheet and unblinded scores from results/runs.jsonl (vroom-9ki.17).

  python3 -I summarize.py table [--round R] [--only S]                 # markdown table per model and packet
  python3 -I summarize.py blind --name NAME [--round R] [--only S] [--per 1]
                                         # blind/NAME.md (no model names) + blind/NAME-key.json (don't open before rating)
  python3 -I summarize.py scores --name NAME   # after rating: results/blind-scores-NAME.json and the mean per model
--round keeps the runs whose round tag contains R; --only the runs whose label (model / prompt / packet set) contains S.
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


def blind(rs: list[dict], per: int, seed: int, only: str | None = None, name: str = "sheet") -> None:
    rng = random.Random(seed)
    by = collections.defaultdict(list)
    for r in rs:
        if only and only not in label(r):
            continue
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
                       f"Write the score after **Score:**. Don't open the answer key (`{'key.json' if name == 'sheet' else name + '-key.json'}`) until every score is in.", ""]
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
    (d / f"{name}.md").write_text("\n".join(lines))
    (d / f"{name}-key.json" if name != "sheet" else d / "key.json").write_text(json.dumps(key, indent=1) + "\n")
    print(f"{len(items)} samples -> blind/{name}.md")


def scores(name: str) -> None:
    """Reads the scores written after **Score:** (a number, or a range such as 3-4, then any note) and unblinds them."""
    import re

    d = HERE / "blind"
    sheet = (d / f"{name}.md").read_text()
    key = json.loads((d / ("key.json" if name == "sheet" else f"{name}-key.json")).read_text())
    out, by = {}, collections.defaultdict(lambda: collections.defaultdict(list))
    for code, body in re.findall(r"^## (S\d\d) · \S+\n(.*?)(?=^## S|\Z)", sheet, flags=re.M | re.S):
        raw = re.search(r"\*\*Score:\*\*\s*(.*)", body).group(1).strip()
        m = re.match(r"(\d+(?:\.\d+)?)(?:\s*-\s*(\d+(?:\.\d+)?))?", raw)
        value = None if not m else (float(m.group(1)) + float(m.group(2) or m.group(1))) / 2
        out[code] = {**key[code], "score": value, "note": raw}
        if value is not None:
            by[key[code]["model"]][key[code]["packet"].split("-")[0]].append(value)
    (HERE / "results" / f"blind-scores-{name}.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    unscored = [c for c, v in out.items() if v["score"] is None]
    print("| Model / prompt / packets | Mean | " + " | ".join(("analyze", "average", "corner")) + " |\n|---|---|---|---|---|")
    for model, per in sorted(by.items(), key=lambda kv: -statistics.mean(v for xs in kv[1].values() for v in xs)):
        allv = [v for xs in per.values() for v in xs]
        cells = [", ".join(f"{v:g}" for v in per.get(k, [])) or "–" for k in ("analyze", "average", "corner")]
        print(f"| {model} | {statistics.mean(allv):.2f} | " + " | ".join(cells) + " |")
    if unscored:
        print(f"\nNot scored yet: {', '.join(unscored)}")


def keep(rs: list[dict], rnd: str | None, only: str | None) -> list[dict]:
    return [r for r in rs if (not rnd or rnd in r.get("round", "")) and (not only or only in label(r))]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("what", choices=["table", "blind", "scores"])
    ap.add_argument("--round", help="only runs whose round tag contains this")
    ap.add_argument("--runs", default=str(HERE / "results" / "runs.jsonl"))
    ap.add_argument("--per", type=int, default=2, help="samples per model and packet in the blind sheet")
    ap.add_argument("--seed", type=int, default=917)
    ap.add_argument("--only", help="only runs whose label contains this (e.g. prompt-v3.md, packets-v2-monza)")
    ap.add_argument("--name", default="sheet", help="blind: sheet file name (round 2: sheet-round2)")
    a = ap.parse_args()
    if a.what == "scores":
        scores(a.name)
        return
    rs = keep(rows(Path(a.runs)), a.round, a.only)
    if a.what == "table":
        print(table(rs))
    else:
        blind(rs, a.per, a.seed, None, a.name)


if __name__ == "__main__":
    main()
